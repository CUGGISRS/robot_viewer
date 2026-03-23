import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { PointerJointDragControls } from '../utils/JointDragControls.js';
import { ModelLoaderFactory } from '../loaders/ModelLoaderFactory.js';
import { EnvironmentManager } from './EnvironmentManager.js';
import { VisualizationManager } from './VisualizationManager.js';
import { InertialVisualization } from './InertialVisualization.js';
import { ConstraintManager } from './ConstraintManager.js';
import { CoordinateAxesManager } from './CoordinateAxesManager.js';
import { HighlightManager } from './HighlightManager.js';
import { MeasurementManager } from './MeasurementManager.js';

/**
 * SceneManager - Core scene management and coordination
 * Delegates specialized tasks to dedicated managers
 */
export class SceneManager {
    constructor(canvas) {
        this.canvas = canvas;
        this.scene = new THREE.Scene();

        // On-demand rendering flags
        this._dirty = false;
        this._pendingRender = false;
        this._renderingPaused = false;

        // Event system
        this._eventListeners = {};

        // Camera
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        this.camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
        this.camera.position.set(2, 2, 2);
        this.camera.lookAt(0, 0, 0);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({
            canvas: canvas,
            antialias: true
        });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(window.devicePixelRatio);

        // Enable shadows
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        // Controls
        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = false;
        this.controls.enablePan = true;
        this.controls.panSpeed = 1.0;
        this.controls.enableZoom = true;
        this.controls.enableRotate = true;
        this.controls.screenSpacePanning = true;
        this.controls.target.set(0, 0, 0);

        // Mark as needing render on controls change
        this.controls.addEventListener('change', () => this.redraw());

        // Set mouse buttons
        if (this.controls.mouseButtons) {
            this.controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
            this.controls.mouseButtons.MIDDLE = THREE.MOUSE.DOLLY;
            this.controls.mouseButtons.RIGHT = THREE.MOUSE.PAN;
        }

        // Set default background color
        this.updateBackgroundColor();

        // Listen for theme changes
        this.setupThemeListener();

        // Environment manager
        this.environmentManager = new EnvironmentManager(this.scene);
        this.environmentManager.setupLights();
        this.environmentManager.setupGroundPlane();

        // Initialize environment map with renderer for reflections
        this.environmentManager.initializeEnvironmentMap(this.renderer);

        // Keep references to ground and lights (compatibility)
        this.groundPlane = this.environmentManager.groundPlane;
        this.referenceGrid = this.environmentManager.referenceGrid;
        this.directionalLight = this.environmentManager.getDirectionalLight();
        this.ambientLight = this.environmentManager.lights.ambient;
        this.fillLight = this.environmentManager.lights.fill;

        // Initialize specialized managers
        this.visualizationManager = new VisualizationManager(this);
        this.inertialVisualization = new InertialVisualization(this);
        this.constraintManager = new ConstraintManager(this);
        this.axesManager = new CoordinateAxesManager(this);
        this.highlightManager = new HighlightManager(this);
        this.measurementManager = new MeasurementManager(this);

        // Current model (UI focus: joints, graph, editor)
        this.currentModel = null;
        /** @type {{ model: import('../models/UnifiedRobotModel.js').UnifiedRobotModel, sceneKey: string|null }[]} */
        this.loadedRobotModels = [];
        /** Single mesh preview (replaces robots; not in loadedRobotModels) */
        this.meshOnlyModel = null;
        this.ignoreLimits = false;

        // Drag controls
        this.dragControls = null;

        // Window resize - use ResizeObserver to listen for canvas container size changes
        this.setupResizeObserver();

        // Start continuous render loop
        this.startRenderLoop();

        // Render immediately to show initial scene
        this.redraw();
    }

    // ==================== Render Loop ====================

    /**
     * Start continuous render loop (borrowed from urdf-loaders implementation)
     */
    startRenderLoop() {
        const renderLoop = () => {
            // Only render when needed (controlled by _dirty flag)
            if (this._dirty) {
                this.renderer.render(this.scene, this.camera);
                this._dirty = false;
            }
            this._renderLoopId = requestAnimationFrame(renderLoop);
        };
        renderLoop();
    }

    stopRenderLoop() {
        if (this._renderLoopId) {
            cancelAnimationFrame(this._renderLoopId);
            this._renderLoopId = null;
        }

        // Clean up ResizeObserver
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
    }

    /**
     * Mark scene as needing re-render (on-demand rendering)
     */
    redraw() {
        this._dirty = true;
    }

    pauseRendering() {
        this._renderingPaused = true;
    }

    resumeRendering() {
        this._renderingPaused = false;
    }

    render() {
        // If rendering is paused, don't render
        if (this._renderingPaused) {
            return;
        }
        // Render immediately (for scenes requiring immediate update)
        this.renderer.render(this.scene, this.camera);
        this._dirty = false;
    }

    // ==================== Model Management ====================

    /**
     * Prefix for axis map keys (avoids duplicate link/joint names across instances)
     */
    makeAxisInstancePrefix(sceneKey) {
        if (!sceneKey) return '';
        return String(sceneKey).replace(/\\/g, '/').replace(/\//g, '_') + '::';
    }

    getRobotModelsForDrag() {
        return this.loadedRobotModels.map((e) => e.model).filter((m) => m?.threeObject);
    }

    /**
     * Remove all robot instances from the scene (keeps grid/lights)
     */
    clearAllRobotModels() {
        while (this.loadedRobotModels.length > 0) {
            this.removeModel(this.loadedRobotModels[0].model);
        }
    }

    /**
     * Switch UI/drag focus without moving objects
     */
    setActiveModel(model, sceneKey = null) {
        if (!model) return;
        this.currentModel = model;
        if (!model.userData) model.userData = {};
        if (sceneKey) model.userData.sceneKey = sceneKey;
        this.initDragControls(this.getRobotModelsForDrag());
        this.setIgnoreLimits(this.ignoreLimits);
    }

    /**
     * @param {import('../models/UnifiedRobotModel.js').UnifiedRobotModel} model
     * @param {{ replace?: boolean, sceneKey?: string|null }} [options]
     */
    addModel(model, options = {}) {
        const { replace = false, sceneKey = null } = options;

        if (!model.userData) model.userData = {};
        if (sceneKey) model.userData.sceneKey = sceneKey;
        const axisPrefix = this.makeAxisInstancePrefix(sceneKey);
        model.userData.axisInstancePrefix = axisPrefix;

        const isSingleMesh = !model.joints || model.joints.size === 0;

        if (isSingleMesh) {
            this.clearAllRobotModels();
            if (this.meshOnlyModel?.threeObject?.parent) {
                this.meshOnlyModel.threeObject.parent.remove(this.meshOnlyModel.threeObject);
            }
            this.meshOnlyModel = model;
            this.currentModel = model;

            if (!model.threeObject) {
                return;
            }

            this.scene.add(model.threeObject);
            this.visualizationManager.extractVisualAndCollision(model);

            let modelSize = 1.0;
            try {
                model.threeObject.updateMatrixWorld(true);
                const bbox = new THREE.Box3().setFromObject(model.threeObject);
                if (!bbox.isEmpty()) {
                    const size = bbox.getSize(new THREE.Vector3());
                    modelSize = Math.max(size.x, size.y, size.z);
                }
            } catch (e) { /* ignore */ }

            this.axesManager.clearAllLinkAxes();
            if (model.links) {
                model.links.forEach((link, linkName) => {
                    this.axesManager.createLinkAxes(link, linkName, modelSize, '');
                });
            }
            this.axesManager.clearAllJointAxes();

            this.inertialVisualization.extractInertialProperties(model);
            this.initDragControls(this.meshOnlyModel ? [this.meshOnlyModel] : []);

            this.updateEnvironment(false);
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this.updateEnvironment(true);
                    this.emit('modelReady', model);
                });
            });
            return;
        }

        if (this.meshOnlyModel?.threeObject?.parent) {
            this.meshOnlyModel.threeObject.parent.remove(this.meshOnlyModel.threeObject);
            this.meshOnlyModel = null;
        }

        if (replace) {
            this.clearAllRobotModels();
        }

        this.currentModel = model;

        if (!model.threeObject) {
            return;
        }

        if (!this.world) {
            this.world = new THREE.Object3D();
            this.scene.add(this.world);
            this.world.rotation.set(-Math.PI / 2, 0, 0);
        }

        this.world.add(model.threeObject);

        const upSelect = document.getElementById('up-select');
        if (upSelect) {
            this.setUp(upSelect.value || '+Z');
        }

        this.axesManager.removeInstanceAxes(axisPrefix);

        this.visualizationManager.extractVisualAndCollision(model);

        let modelSize = 1.0;
        try {
            if (model.threeObject) {
                model.threeObject.updateMatrixWorld(true);
                const bbox = new THREE.Box3().setFromObject(model.threeObject);
                if (!bbox.isEmpty()) {
                    const size = bbox.getSize(new THREE.Vector3());
                    modelSize = Math.max(size.x, size.y, size.z);
                }
            }
        } catch (error) {
            // Failed to calculate model size, using default
        }

        if (model.links) {
            model.links.forEach((link, linkName) => {
                this.axesManager.createLinkAxes(link, linkName, modelSize, axisPrefix);
            });
        }

        if (model.joints) {
            model.joints.forEach((joint, jointName) => {
                this.axesManager.createJointAxis(joint, jointName, axisPrefix);
            });
        }

        this.inertialVisualization.extractInertialProperties(model);

        this.constraintManager.visualizeConstraints(model, this.world);

        if (model.constraints && model.constraints.size > 0) {
            this.constraintManager.applyConstraints(model, null);
        }

        const idx = this.loadedRobotModels.findIndex((e) => e.sceneKey === sceneKey && sceneKey);
        if (idx >= 0) {
            this.loadedRobotModels[idx] = { model, sceneKey };
        } else {
            this.loadedRobotModels.push({ model, sceneKey });
        }

        this.initDragControls(this.getRobotModelsForDrag());

        this.updateEnvironment(false);

        setTimeout(() => {
            this.visualizationManager.extractVisualAndCollision(model);
        }, 100);

        setTimeout(() => {
            this.visualizationManager.extractVisualAndCollision(model);
            this.updateEnvironment(true);
            this.emit('modelReady', model);
        }, 1000);

        setTimeout(() => {
            this.visualizationManager.extractVisualAndCollision(model);
        }, 2500);
    }

    removeModel(model) {
        if (!model) return;

        if (this.meshOnlyModel === model) {
            if (model.threeObject?.parent) {
                model.threeObject.parent.remove(model.threeObject);
            }
            this.visualizationManager.removeModelResources(model);
            this.axesManager.clear();
            this.inertialVisualization.removeModelInertial(model);
            this.meshOnlyModel = null;
            if (this.currentModel === model) {
                this.currentModel = null;
            }
            if (this.dragControls) {
                this.dragControls.dispose();
                this.dragControls = null;
            }
            this.measurementManager.clear();
            this.highlightManager.clearHighlight();
            return;
        }

        const idx = this.loadedRobotModels.findIndex((e) => e.model === model);
        if (idx < 0) {
            return;
        }

        if (model.threeObject?.parent) {
            model.threeObject.parent.remove(model.threeObject);
        }

        this.visualizationManager.removeModelResources(model);
        this.axesManager.removeInstanceAxes(model.userData?.axisInstancePrefix || '');
        this.inertialVisualization.removeModelInertial(model);
        this.constraintManager.removeConstraintsForModel(model);
        this.measurementManager.clear();
        this.highlightManager.clearHighlight();

        this.loadedRobotModels.splice(idx, 1);

        if (this.currentModel === model) {
            this.currentModel = this.loadedRobotModels[0]?.model || null;
        }

        if (this.dragControls) {
            this.dragControls.dispose();
            this.dragControls = null;
        }
        const dragList = this.getRobotModelsForDrag();
        if (dragList.length > 0) {
            this.initDragControls(dragList);
        }
    }

    // ==================== Environment & Camera ====================

    /**
     * Update environment (reference urdf-loaders' _updateEnvironment)
     * Auto-adjust ground position to robot lowest point, and update camera focus
     * @param {boolean} fitCamera - Whether to auto-adjust camera view (default false)
     */
    updateEnvironment(fitCamera = false) {
        const roots = [];
        this.loadedRobotModels.forEach(({ model: m }) => {
            if (m?.threeObject) roots.push(m.threeObject);
        });
        if (this.meshOnlyModel?.threeObject) {
            roots.push(this.meshOnlyModel.threeObject);
        }
        if (roots.length === 0) {
            return;
        }

        if (this.world) {
            this.world.updateMatrixWorld(true);
        }

        const bboxGlobal = new THREE.Box3();
        let first = true;
        roots.forEach((root) => {
            root.updateMatrixWorld(true);
            const b = new THREE.Box3().setFromObject(root, true);
            if (b.isEmpty()) return;
            if (first) {
                bboxGlobal.copy(b);
                first = false;
            } else {
                bboxGlobal.union(b);
            }
        });

        if (first || bboxGlobal.isEmpty()) {
            return;
        }

        const center = bboxGlobal.getCenter(new THREE.Vector3());
        const size = bboxGlobal.getSize(new THREE.Vector3());
        const minY = bboxGlobal.min.y;  // In scene global coordinate system, Y is vertical direction

        // Update ground position to model lowest point (robot touches ground)
        let groundChanged = false;
        if (this.groundPlane) {
            const newGroundY = minY;  // Move ground to robot lowest point
            const oldGroundY = this.groundPlane.position.y;
            this.groundPlane.position.y = newGroundY;

            // Also update grid position, keep aligned with ground
            if (this.referenceGrid) {
                const oldGridY = this.referenceGrid.position.y;
                this.referenceGrid.position.y = newGroundY;
                this.referenceGrid.updateMatrixWorld(true);
            }

            // Detailed debug info
            // If ground position changed, mark for measurement update
            if (Math.abs(oldGroundY - newGroundY) > 1e-6) {
                groundChanged = true;
            }
        }

        // If camera adjustment needed, perform auto-zoom and positioning
        if (fitCamera) {
            this.fitCameraToModel(bboxGlobal, center, size);
        }

        // If ground position changed, trigger measurement update callback
        if (groundChanged && this.onMeasurementUpdate) {
            this.onMeasurementUpdate();
        }

        // Update directional light shadow camera (reference urdf-loaders)
        const dirLight = this.directionalLight;
        if (dirLight && dirLight.castShadow) {
            // Use bounding sphere to set shadow camera range
            const sphere = bboxGlobal.getBoundingSphere(new THREE.Sphere());
            const minmax = sphere.radius;

            const cam = dirLight.shadow.camera;
            cam.left = cam.bottom = -minmax;
            cam.right = cam.top = minmax;

            // Make directional light follow model center
            const offset = dirLight.position.clone().sub(dirLight.target.position);
            dirLight.target.position.copy(center);
            dirLight.position.copy(center).add(offset);

            cam.updateProjectionMatrix();
        }

        this.redraw();
    }

    /**
     * Auto-adjust camera position to fit model size
     * View angle: oblique from side-back (looking at model from side-back)
     * @param {THREE.Box3} bbox - Model bounding box
     * @param {THREE.Vector3} center - Model center point
     * @param {THREE.Vector3} size - Model dimensions
     */
    fitCameraToModel(bbox, center, size) {
        // Calculate model's maximum dimension
        const maxDim = Math.max(size.x, size.y, size.z);

        if (maxDim < 0.001) {
            return;
        }

        // Calculate appropriate camera distance (based on FOV and model size)
        // Single mesh uses larger distance multiplier to avoid clipping
        const fov = this.camera.fov * (Math.PI / 180);

        // Check if single mesh model (no joints)
        const isSingleMesh = !this.currentModel || !this.currentModel.joints || this.currentModel.joints.size === 0;
        const distanceMultiplier = isSingleMesh ? 2.5 : 1.8;  // Single mesh: 2.5x distance, robot model: 1.8x distance

        const distance = maxDim / (2 * Math.tan(fov / 2)) * distanceMultiplier;

        // Side-back oblique view:
        // - From right-back (X positive + Z negative)
        // - Slightly looking down (Y positive)
        // Standard oblique angle: horizontal 135 degrees (back-side), vertical about 35 degrees
        const horizontalAngle = Math.PI * 3 / 4;  // 135 degrees (right-back)
        const verticalAngle = Math.PI / 6;        // 30 degrees (slightly looking down)

        // Calculate camera position (relative to model center)
        const cameraOffset = new THREE.Vector3(
            distance * Math.cos(verticalAngle) * Math.sin(horizontalAngle),  // X: positive direction (right side)
            distance * Math.sin(verticalAngle),                               // Y: positive direction (top)
            -distance * Math.cos(verticalAngle) * Math.cos(horizontalAngle)  // Z: negative direction (back)
        );

        // Set camera position and target
        this.camera.position.copy(center).add(cameraOffset);
        this.controls.target.copy(center);

        // Update controls and camera
        this.controls.update();
        this.camera.updateProjectionMatrix();

        this.redraw();
    }

    /**
     * Set coordinate system up direction
     */
    setUp(up) {
        if (!up) up = '+Z';
        up = up.toUpperCase();
        const sign = up.replace(/[^-+]/g, '')[0] || '+';
        const axis = up.replace(/[^XYZ]/gi, '')[0] || 'Z';

        const PI = Math.PI;
        const HALFPI = PI / 2;

        // If world doesn't exist, create it
        if (!this.world) {
            this.world = new THREE.Object3D();
            this.scene.add(this.world);
            // If current model in scene, move to world
            if (this.currentModel && this.currentModel.threeObject && this.currentModel.threeObject.parent === this.scene) {
                this.scene.remove(this.currentModel.threeObject);
                this.world.add(this.currentModel.threeObject);
            }
        }

        // Apply coordinate system rotation
        if (axis === 'X') {
            this.world.rotation.set(0, 0, sign === '+' ? HALFPI : -HALFPI);
        } else if (axis === 'Z') {
            this.world.rotation.set(sign === '+' ? -HALFPI : HALFPI, 0, 0);
        } else if (axis === 'Y') {
            this.world.rotation.set(sign === '+' ? 0 : PI, 0, 0);
        }

        // Ensure matrix update
        this.world.updateMatrixWorld(true);

        // Trigger render immediately to show coordinate system change
        this.redraw();
    }

    /**
     * Set ground visibility
     */
    setGroundVisible(visible) {
        if (this.groundPlane) {
            this.groundPlane.visible = visible;
            this.redraw();
        }
    }

    /**
     * Focus object (center camera on object)
     */
    focusObject(object) {
        if (!object) return;

        // Calculate object's bounding box
        const box = new THREE.Box3().setFromObject(object);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());

        // Calculate appropriate camera distance
        const maxDim = Math.max(size.x, size.y, size.z);
        const fov = this.camera.fov * (Math.PI / 180);
        let cameraDistance = Math.abs(maxDim / Math.sin(fov / 2)) * 1.5;

        // Get current camera direction
        const direction = new THREE.Vector3();
        this.camera.getWorldDirection(direction);

        // Set camera position
        const newCameraPosition = center.clone().sub(direction.multiplyScalar(cameraDistance));
        this.camera.position.copy(newCameraPosition);

        // Update controls target
        this.controls.target.copy(center);
        this.controls.update();

        this.redraw();
    }

    // ==================== Drag Controls ====================

    initDragControls(models) {
        if (this.dragControls) {
            this.dragControls.dispose();
        }

        const list = Array.isArray(models) ? models.filter(Boolean) : (models ? [models] : []);

        this.dragControls = new PointerJointDragControls(
            this.scene,
            this.camera,
            this.canvas,
            list
        );

        if (list.length > 0) {
            this.dragControls.model = list[0];
        }

        // Pass renderer reference for rendering during drag
        this.dragControls.renderer = this.renderer;

        list.forEach((model) => {
            if (!model) return;
            if (!model.userData) {
                model.userData = {};
            }
            model.userData.ignoreLimits = this.ignoreLimits;
            if (model.threeObject) {
                if (!model.threeObject.userData) {
                    model.threeObject.userData = {};
                }
                model.threeObject.userData.ignoreLimits = this.ignoreLimits;
            }
        });

        this.dragControls.onUpdateJoint = (joint, angle, sourceModel) => {
            const model = sourceModel || this.currentModel;
            if (!model) return;

            const checkIgnoreLimits = this.ignoreLimits ||
                                     (model.userData && model.userData.ignoreLimits) ||
                                     (model.threeObject && model.threeObject.userData && model.threeObject.userData.ignoreLimits);

            if (!checkIgnoreLimits && joint.limits) {
                angle = Math.max(joint.limits.lower, Math.min(joint.limits.upper, angle));
            }

            ModelLoaderFactory.setJointAngle(model, joint.name, angle);
            joint.currentValue = angle;

            this.constraintManager.applyConstraints(model, joint);

            const slider = document.querySelector(`input[data-joint="${joint.name}"]`);
            if (slider) {
                slider.value = angle;

                const valueInput = document.querySelector(`input[data-joint-input="${joint.name}"]`);
                if (valueInput) {
                    const angleUnit = document.querySelector('#unit-deg.active') ? 'deg' : 'rad';
                    if (angleUnit === 'deg') {
                        valueInput.value = (angle * 180 / Math.PI).toFixed(2);
                    } else {
                        valueInput.value = angle.toFixed(2);
                    }
                }
            }

            this.redraw();

            if (this.onMeasurementUpdate) {
                this.onMeasurementUpdate();
            }
        };

        this.dragControls.onHover = (link) => {
            if (link) {
                const m = this.dragControls.hoverModel || this.currentModel;
                this.highlightManager.highlightLink(link, m);
            }
        };

        this.dragControls.onUnhover = (link) => {
            if (link) {
                const m = this.dragControls.hoverModel || this.currentModel;
                this.highlightManager.unhighlightLink(link, m);
            }
        };

        this.dragControls.onDragStart = (link) => {
            this.controls.enabled = false;

            const model = this.dragControls.hoverModel || this.currentModel;

            if (link && link.threeObject && model) {
                let currentLink = link.threeObject;
                while (currentLink) {
                    const parentObject = currentLink.parent;
                    if (parentObject && (parentObject.type === 'URDFJoint' || parentObject.isURDFJoint)) {
                        const jointName = parentObject.name;
                        if (jointName && model.joints && model.joints.has(jointName)) {
                            const joint = model.joints.get(jointName);
                            if (joint.type !== 'fixed') {
                                this.axesManager.showOnlyJointAxis(joint);
                                break;
                            }
                        }
                    }
                    currentLink = parentObject;
                }
            }
        };

        this.dragControls.onDragEnd = (link) => {
            this.controls.enabled = true;

            // Restore all joint axes display
            this.axesManager.restoreAllJointAxes();

            // Only update environment after drag ends (ground position, shadows, etc.)
            this.updateEnvironment();
        };
    }

    // ==================== Core Settings ====================

    setIgnoreLimits(ignore) {
        this.ignoreLimits = ignore;

        const all = [...this.getRobotModelsForDrag()];
        if (this.meshOnlyModel) {
            all.push(this.meshOnlyModel);
        }

        all.forEach((model) => {
            if (!model) return;
            if (!model.userData) {
                model.userData = {};
            }
            model.userData.ignoreLimits = ignore;
            if (model.threeObject) {
                if (!model.threeObject.userData) {
                    model.threeObject.userData = {};
                }
                model.threeObject.userData.ignoreLimits = ignore;
            }
        });

        if (this.dragControls && this.dragControls.models) {
            this.dragControls.models.forEach((m) => {
                if (!m) return;
                if (!m.userData) m.userData = {};
                m.userData.ignoreLimits = ignore;
                if (m.threeObject) {
                    if (!m.threeObject.userData) m.threeObject.userData = {};
                    m.threeObject.userData.ignoreLimits = ignore;
                }
            });
        }
    }

    // ==================== Mesh Coordinate System Display ====================

    /**
     * Show mesh local coordinate system and grid
     */
    showMeshCoordinateSystem(meshObject) {
        if (!meshObject) {
            return;
        }
        // Clear previous coordinate system and grid helpers
        this.clearMeshHelper();

        // Find actual mesh (meshObject might be Group)
        let actualMesh = null;
        meshObject.traverse((child) => {
            if (child.isMesh && !actualMesh) {
                actualMesh = child;
            }
        });

        if (!actualMesh) {
            return;
        }
        // Calculate mesh bounding box to determine appropriate axes size
        actualMesh.geometry.computeBoundingBox();
        const bbox = new THREE.Box3().setFromObject(actualMesh);
        const size = bbox.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        const center = bbox.getCenter(new THREE.Vector3());

        // Create axes helper - reasonably scaled based on model size
        const axesSize = Math.max(maxDim * 2.5, 0.5); // 2.5x model size, minimum 0.5m
        const axesGroup = new THREE.Group();
        axesGroup.name = 'meshCoordinateAxes';

        // Create three axes (X-red, Y-green, Z-blue)
        const axisRadius = Math.max(axesSize * 0.02, 0.008); // Axis thickness 2% of length, minimum 8mm
        const axisGeometry = new THREE.CylinderGeometry(axisRadius, axisRadius, axesSize, 16);
        // X axis (red)
        const xAxisMaterial = new THREE.MeshPhongMaterial({
            color: 0xff0000,
            shininess: 30,
            depthTest: true,
            side: THREE.DoubleSide
        });
        const xAxis = new THREE.Mesh(axisGeometry, xAxisMaterial);
        xAxis.position.x = axesSize / 2;
        xAxis.rotation.z = -Math.PI / 2;
        xAxis.castShadow = false;
        xAxis.receiveShadow = false;
        xAxis.name = 'xAxis';
        axesGroup.add(xAxis);

        // Y axis (green)
        const yAxisMaterial = new THREE.MeshPhongMaterial({
            color: 0x00ff00,
            shininess: 30,
            depthTest: true,
            side: THREE.DoubleSide
        });
        const yAxis = new THREE.Mesh(axisGeometry, yAxisMaterial);
        yAxis.position.y = axesSize / 2;
        yAxis.castShadow = false;
        yAxis.receiveShadow = false;
        yAxis.name = 'yAxis';
        axesGroup.add(yAxis);

        // Z axis (blue)
        const zAxisMaterial = new THREE.MeshPhongMaterial({
            color: 0x0000ff,
            shininess: 30,
            depthTest: true,
            side: THREE.DoubleSide
        });
        const zAxis = new THREE.Mesh(axisGeometry, zAxisMaterial);
        zAxis.position.z = axesSize / 2;
        zAxis.rotation.x = Math.PI / 2;
        zAxis.castShadow = false;
        zAxis.receiveShadow = false;
        zAxis.name = 'zAxis';
        axesGroup.add(zAxis);

        // Add directly to meshObject, display at its local coordinate system origin
        meshObject.add(axesGroup);
        // Create wireframe helper (WireframeGeometry)
        const wireframeGeometry = new THREE.WireframeGeometry(actualMesh.geometry);
        const wireframeMaterial = new THREE.LineBasicMaterial({
            color: 0x00ff00, // Green wireframe
            linewidth: 1,
            transparent: true,
            opacity: 0.6,
            depthTest: true
        });
        const wireframe = new THREE.LineSegments(wireframeGeometry, wireframeMaterial);
        wireframe.name = 'meshWireframe';

        // Add wireframe as sibling node of actualMesh, maintain same local transform
        if (actualMesh.parent) {
            wireframe.position.copy(actualMesh.position);
            wireframe.rotation.copy(actualMesh.rotation);
            wireframe.scale.copy(actualMesh.scale);
            actualMesh.parent.add(wireframe);
        }

        // Save references for later cleanup
        this.meshCoordinateAxes = axesGroup;
        this.meshWireframe = wireframe;

        // Update matrix to ensure immediate display
        if (axesGroup.parent) {
            axesGroup.parent.updateMatrixWorld(true);
        }
        if (wireframe && wireframe.parent) {
            wireframe.parent.updateMatrixWorld(true);
        }

        // Force re-render multiple times to ensure axes display
        this.redraw();
        this.render();
        requestAnimationFrame(() => {
            this.redraw();
            this.render();
        });

        // Clear highlight (don't auto-highlight mesh)
        this.highlightManager.clearHighlight();

        this.redraw();    }

    /**
     * Clear mesh helpers (coordinate system and wireframe)
     */
    clearMeshHelper() {
        if (this.meshCoordinateAxes) {
            if (this.meshCoordinateAxes.parent) {
                this.meshCoordinateAxes.parent.remove(this.meshCoordinateAxes);
            }
            this.meshCoordinateAxes = null;
        }

        if (this.meshWireframe) {
            if (this.meshWireframe.parent) {
                this.meshWireframe.parent.remove(this.meshWireframe);
            }
            this.meshWireframe = null;
        }

        this.redraw();
    }

    // ==================== Visual Transparency Update ====================

    /**
     * Update visual model transparency
     * When COM, axes, or joint axes enabled, set model to semi-transparent
     * Note: Only affects robot models with joints, not single meshes
     */
    updateVisualTransparency() {
        // Check if single mesh model (no joints)
        const isSingleMesh = !this.currentModel || !this.currentModel.joints || this.currentModel.joints.size === 0;

        this.visualizationManager.updateVisualTransparency(
            this.inertialVisualization.showCOM,
            this.axesManager.showAxesEnabled,
            this.axesManager.showJointAxesEnabled,
            isSingleMesh
        );
    }

    // ==================== Theme & Resize ====================

    setupThemeListener() {
        const observer = new MutationObserver(() => {
            this.updateBackgroundColor();
        });

        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
    }

    updateBackgroundColor() {
        const theme = document.documentElement.getAttribute('data-theme') || 'dark';
        if (theme === 'light') {
            // Light theme: pure white background
            this.scene.background = new THREE.Color(0xffffff);
        } else {
            // Dark theme: medium gray background (easier to see model and shadows)
            this.scene.background = new THREE.Color(0x505050);
        }

        // Also update grid color to match theme
        if (this.environmentManager) {
            this.environmentManager.updateGridColorForTheme(theme);
        }

        // Trigger render immediately to show background color change
            this.redraw();
    }

    setupResizeObserver() {
        // Use ResizeObserver to listen for canvas container size changes
        const container = this.canvas.parentElement;
        if (!container) {
            window.addEventListener('resize', () => this.onWindowResize());
            return;
        }

        // Create ResizeObserver
        this.resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                // Use contentBoxSize to get more precise dimensions
                if (entry.contentBoxSize) {
                    const contentBoxSize = Array.isArray(entry.contentBoxSize)
                        ? entry.contentBoxSize[0]
                        : entry.contentBoxSize;

                    const width = contentBoxSize.inlineSize;
                    const height = contentBoxSize.blockSize;

                    this.handleResize(width, height);
                } else {
                    // Fallback
                    this.onWindowResize();
                }
            }
        });

        // Start observing container
        this.resizeObserver.observe(container);
    }

    handleResize(width, height) {
        // Ensure dimensions are valid
        if (width === 0 || height === 0 || !isFinite(width) || !isFinite(height)) {
            return;
        }

        // Update camera aspect ratio
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        // Update renderer size
        this.renderer.setSize(width, height, true);
        this.renderer.setPixelRatio(window.devicePixelRatio);

        // Render immediately
        this.render();
    }

    onWindowResize() {
        // Get container's actual dimensions
        const width = this.canvas.clientWidth;
        const height = this.canvas.clientHeight;

        // Ensure dimensions are valid
        if (width === 0 || height === 0) {
            return;
        }

        // Update camera aspect ratio
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        // Update renderer size (updateStyle set to true to update canvas style)
        this.renderer.setSize(width, height, true);
        this.renderer.setPixelRatio(window.devicePixelRatio);

        // Render immediately to avoid black areas
        this.render();
    }

    // ==================== Event System ====================

    on(eventName, callback) {
        if (!this._eventListeners[eventName]) {
            this._eventListeners[eventName] = [];
        }
        this._eventListeners[eventName].push(callback);
    }

    off(eventName, callback) {
        if (!this._eventListeners[eventName]) return;
        this._eventListeners[eventName] = this._eventListeners[eventName].filter(cb => cb !== callback);
    }

    emit(eventName, ...args) {
        if (!this._eventListeners[eventName]) return;
        this._eventListeners[eventName].forEach(callback => callback(...args));
    }

    update() {
        this.controls.update();
    }
}
