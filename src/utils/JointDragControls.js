import * as THREE from 'three';
import { MathUtils } from './MathUtils.js';

/**
 * Universal joint drag control system
 * Supports URDF, MJCF, USD and other formats
 */

/**
 * Check if object is a joint (for URDF special cases)
 */
function isURDFJoint(obj) {
    return obj && obj.isURDFJoint && obj.jointType !== 'fixed';
}

/**
 * Find the Link that the clicked object belongs to
 * Traverse upward from clicked mesh to find first URDFLink object
 * Simple and direct, no merge logic
 */
function findParentLink(hitObject, model) {
    if (!model || !model.threeObject) {
        return null;
    }

    let current = hitObject;
    const modelRoot = model.threeObject;

    // Traverse upward to find first URDFLink object
    while (current) {
        // Check if is URDFLink
        if (current.type === 'URDFLink' || current.isURDFLink) {
            const linkName = current.name;
            if (linkName && model.links && model.links.has(linkName)) {
                const linkData = model.links.get(linkName);
                // Return information including link data and Three.js object
                return {
                    linkData: linkData,
                    threeObject: current,
                    name: linkName
                };
            }
        }

        // If reached model root node, stop searching
        if (current === modelRoot || !current.parent) {
            break;
        }

        current = current.parent;
    }

    return null;
}

/**
 * Find parent joint of Link (for drag rotation)
 * Skip fixed joints, find first movable joint
 */
function findParentJoint(link, model) {
    if (!link || !link.threeObject || !model.joints) {
        return null;
    }

    let currentLink = link.threeObject;

    // Search upward, skip fixed joints
    while (currentLink) {
        const parentObject = currentLink.parent;

        // If parent object is joint
        if (parentObject && (parentObject.type === 'URDFJoint' || parentObject.isURDFJoint)) {
            const jointName = parentObject.name;
            if (jointName && model.joints.has(jointName)) {
                const joint = model.joints.get(jointName);

                // If movable joint, return it
                if (joint.type !== 'fixed') {
                    return joint;
                }

                // If fixed joint, continue searching upward
                // Find this joint's parent link
                const parentLink = parentObject.parent;
                if (parentLink && (parentLink.type === 'URDFLink' || parentLink.isURDFLink)) {
                    currentLink = parentLink;
                    continue;
                }
            }
        }

        // No parent joint or reached root node
        break;
    }

    return null;
}

const prevHitPoint = new THREE.Vector3();
const newHitPoint = new THREE.Vector3();
const pivotPoint = new THREE.Vector3();
const tempVector = new THREE.Vector3();
const tempVector2 = new THREE.Vector3();
const projectedStartPoint = new THREE.Vector3();
const projectedEndPoint = new THREE.Vector3();
const plane = new THREE.Plane();

/**
 * Universal joint drag controller base class
 */
export class JointDragControls {
    constructor(scene, camera, domElement, model) {
        this.enabled = true;
        this.scene = scene;
        this.camera = camera;
        this.domElement = domElement;
        /** @type {import('../models/UnifiedRobotModel.js').UnifiedRobotModel[]} */
        this.models = Array.isArray(model) ? model.filter(Boolean) : (model ? [model] : []);
        this.model = this.models[0] || null;
        /** Model under cursor (multi-robot) or joint being dragged */
        this.hoverModel = null;
        this.dragJointModel = null;
        this.raycaster = new THREE.Raycaster();
        // Allow raycasting to detect invisible objects (for when visual is hidden)
        this.raycaster.layers.enableAll();
        this.initialGrabPoint = new THREE.Vector3();
        this.hitDistance = -1;
        this.hovered = null;
        this.manipulating = null;
        this.renderer = null;
    }

    /**
     * @param {THREE.Raycaster} raycaster
     * @param {import('../models/UnifiedRobotModel.js').UnifiedRobotModel} model
     */
    _intersectModelForHover(raycaster, model) {
        const hiddenMeshes = [];
        model.threeObject.traverse((child) => {
            if (child.isMesh && !child.visible) {
                let isInCollider = false;
                let checkNode = child;
                while (checkNode) {
                    if (checkNode.isURDFCollider) {
                        isInCollider = true;
                        break;
                    }
                    checkNode = checkNode.parent;
                }
                if (!isInCollider) {
                    child.visible = true;
                    hiddenMeshes.push(child);
                }
            }
        });

        const intersections = raycaster.intersectObject(model.threeObject, true);

        hiddenMeshes.forEach(mesh => {
            mesh.visible = false;
        });

        const validIntersections = intersections.filter(intersect => {
            const obj = intersect.object;
            if (obj.isURDFCollider || obj.userData?.isCollision || obj.userData?.isCollisionGeom) {
                return false;
            }
            let isInCollider = false;
            let checkNode = obj;
            while (checkNode) {
                if (checkNode.isURDFCollider) {
                    isInCollider = true;
                    break;
                }
                checkNode = checkNode.parent;
            }
            if (isInCollider) {
                return false;
            }
            return obj.isMesh;
        });

        if (validIntersections.length === 0) {
            return null;
        }
        return validIntersections[0];
    }

    update() {
        const { raycaster, hovered, manipulating } = this;

        if (manipulating || !this.enabled) {
            return;
        }

        const models = this.models && this.models.length > 0 ? this.models : (this.model ? [this.model] : []);
        if (models.length === 0) {
            return;
        }

        let hoveredLink = null;
        let pickModel = null;
        let bestHit = null;
        let bestDist = Infinity;

        for (const model of models) {
            if (!model?.threeObject) continue;
            const hit = this._intersectModelForHover(raycaster, model);
            if (hit && hit.distance < bestDist) {
                bestDist = hit.distance;
                bestHit = hit;
                pickModel = model;
            }
        }

        this.hoverModel = pickModel;

        if (bestHit && pickModel) {
            hoveredLink = findParentLink(bestHit.object, pickModel);

            if (hoveredLink) {
                this.hitDistance = bestHit.distance;
                this.initialGrabPoint.copy(bestHit.point);
            }
        }

        // Include sceneKey so duplicate link names across robots trigger hover change
        const keyA = hoveredLink && pickModel
            ? `${pickModel.userData?.sceneKey || ''}::${hoveredLink.name}`
            : null;
        const keyB = hovered && this._lastHoverPickModel
            ? `${this._lastHoverPickModel.userData?.sceneKey || ''}::${hovered.name}`
            : null;

        if (keyA !== keyB) {
            if (hovered) {
                this.onUnhover(hovered);
            }
            this.hovered = hoveredLink;
            this._lastHoverPickModel = pickModel;
            if (hoveredLink) {
                this.onHover(hoveredLink);
            }
        } else if (hoveredLink && hovered) {
            this.hovered = hoveredLink;
            this._lastHoverPickModel = pickModel;
        }
    }

    updateJoint(joint, angle) {
        if (this.onUpdateJoint) {
            const sourceModel = this.dragJointModel || this.model;
            this.onUpdateJoint(joint, angle, sourceModel);
        }
    }

    onDragStart(link) {
        // Subclasses can override, parameter is dragged link
    }

    onDragEnd(link) {
        // Subclasses can override, parameter is dragged link
    }

    onHover(link) {
        // Subclasses can override, parameter is hovered link
    }

    onUnhover(link) {
        // Subclasses can override, parameter is link leaving hover
    }

    /**
     * Get joint axis vector (universal method)
     */
    getJointAxis(joint) {
        // Prefer getting axis from threeObject
        if (joint.threeObject) {
            // URDF: joint.threeObject.axis (Vector3)
            if (joint.threeObject.axis instanceof THREE.Vector3) {
                return joint.threeObject.axis.clone();
            }
            // Other formats may have different structures
        }

        // Use unified model axis data
        if (joint.axis && joint.axis.xyz) {
            return MathUtils.xyzToVector3(joint.axis.xyz);
        }

        // Default z-axis
        return new THREE.Vector3(0, 0, 1);
    }

    /**
     * Get joint's Three.js object (for matrix transformations)
     */
    getJointThreeObject(joint) {
        return joint.threeObject;
    }

    /**
     * Get joint current value (universal method)
     */
    getJointCurrentValue(joint) {
        // Prefer getting from threeObject
        if (joint.threeObject) {
            // URDF: joint.threeObject.angle
            if (joint.threeObject.angle !== undefined) {
                return joint.threeObject.angle;
            }
            // URDF: joint.threeObject.jointValue[0]
            if (joint.threeObject.jointValue && joint.threeObject.jointValue.length > 0) {
                return joint.threeObject.jointValue[0];
            }
        }

        // Use unified model currentValue
        return joint.currentValue !== undefined ? joint.currentValue : 0;
    }

    getRevoluteDelta(joint, startPoint, endPoint) {
        const jointObj = this.getJointThreeObject(joint);
        if (!jointObj) {
            return 0;
        }

        const axis = this.getJointAxis(joint);

        tempVector
            .copy(axis)
            .transformDirection(jointObj.matrixWorld)
            .normalize();
        pivotPoint
            .set(0, 0, 0)
            .applyMatrix4(jointObj.matrixWorld);
        plane
            .setFromNormalAndCoplanarPoint(tempVector, pivotPoint);

        // project the drag points onto the plane
        plane.projectPoint(startPoint, projectedStartPoint);
        plane.projectPoint(endPoint, projectedEndPoint);

        // get the directions relative to the pivot
        projectedStartPoint.sub(pivotPoint);
        projectedEndPoint.sub(pivotPoint);

        tempVector.crossVectors(projectedStartPoint, projectedEndPoint);

        const dot = tempVector.dot(plane.normal);
        const direction = Math.sign(dot);
        const angle = projectedEndPoint.angleTo(projectedStartPoint);
        const delta = direction * angle;

        return delta;
    }

    getPrismaticDelta(joint, startPoint, endPoint) {
        const jointObj = this.getJointThreeObject(joint);
        if (!jointObj) return 0;

        tempVector.subVectors(endPoint, startPoint);
        const axis = this.getJointAxis(joint);

        plane.normal
            .copy(axis)
            .transformDirection(jointObj.parent?.matrixWorld || new THREE.Matrix4())
            .normalize();

        return tempVector.dot(plane.normal);
    }

    moveRay(toRay) {
        const { raycaster, hitDistance, manipulating } = this;
        const { ray } = raycaster;

        if (manipulating) {
            ray.at(hitDistance, prevHitPoint);
            toRay.at(hitDistance, newHitPoint);

            let delta = 0;
            const jointType = manipulating.type;

            if (jointType === 'revolute' || jointType === 'continuous') {
                delta = this.getRevoluteDelta(manipulating, prevHitPoint, newHitPoint);
            } else if (jointType === 'prismatic') {
                delta = this.getPrismaticDelta(manipulating, prevHitPoint, newHitPoint);
            }

            if (delta) {
                const currentValue = this.getJointCurrentValue(manipulating);
                let newAngle = currentValue + delta;

                // Apply limits
                if (manipulating.limits) {
                    const limModel = this.dragJointModel || this.model;
                    const ignoreLimits = limModel?.userData?.ignoreLimits || limModel?.threeObject?.userData?.ignoreLimits || false;
                    if (!ignoreLimits) {
                        newAngle = Math.max(manipulating.limits.lower, Math.min(manipulating.limits.upper, newAngle));
                    }
                }

                this.updateJoint(manipulating, newAngle);
            }
        }

        this.raycaster.ray.copy(toRay);
        this.update();
    }

    setGrabbed(grabbed) {
        const { hovered, manipulating } = this;

        if (grabbed) {
            if (manipulating !== null || hovered === null) {
                return;
            }

            const pickModel = this.hoverModel || this.models[0] || this.model;
            const parentJoint = findParentJoint(hovered, pickModel);

            if (parentJoint) {
                this.dragJointModel = pickModel;
                this.manipulating = parentJoint;
                this.manipulatingLink = hovered;
                this.onDragStart(hovered);
            } else {
                this.dragJointModel = pickModel;
                this.manipulatingLink = hovered;
                this.onDragStart(hovered);
            }
        } else {
            if (this.manipulating === null && !this.manipulatingLink) {
                return;
            }
            this.onDragEnd(this.manipulatingLink || hovered);  // Callback passes link
            this.manipulating = null;
            this.manipulatingLink = null;
            this.dragJointModel = null;
            this.update();
        }
    }
}

/**
 * Pointer-based joint drag controller
 */
export class PointerJointDragControls extends JointDragControls {
    constructor(scene, camera, domElement, model) {
        super(scene, camera, domElement, model);
        this.camera = camera;
        this.domElement = domElement;

        // Create local raycaster for mouse events (critical fix!)
        const raycaster = new THREE.Raycaster();
        const mouse = new THREE.Vector2();

        const updateMouse = (e) => {
            // Use getBoundingClientRect() to get more accurate coordinates
            const rect = domElement.getBoundingClientRect();
            mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        };

        this._mouseDown = e => {
            if (e.button !== 0) return;
            updateMouse(e);
            raycaster.setFromCamera(mouse, this.camera);

            const models = this.models && this.models.length > 0 ? this.models : (this.model ? [this.model] : []);
            if (models.length === 0) return;

            let bestHit = null;
            let pickModel = null;
            let bestDist = Infinity;

            for (const model of models) {
                if (!model?.threeObject) continue;
                const hit = this._intersectModelForHover(raycaster, model);
                if (hit && hit.distance < bestDist) {
                    bestDist = hit.distance;
                    bestHit = hit;
                    pickModel = model;
                }
            }

            this.hoverModel = pickModel;

            const hitLink = bestHit && pickModel
                ? findParentLink(bestHit.object, pickModel)
                : null;

            if (hitLink) {
                this.hitDistance = bestHit.distance;
                this.initialGrabPoint.copy(bestHit.point);
                this.moveRay(raycaster.ray);
                this.setGrabbed(true);
            }
        };

        this._mouseMove = e => {
            updateMouse(e);
            raycaster.setFromCamera(mouse, this.camera);
            this.moveRay(raycaster.ray);
        };

        this._mouseUp = e => {
            if (e.button !== 0) return;
            updateMouse(e);
            raycaster.setFromCamera(mouse, this.camera);
            this.moveRay(raycaster.ray);
            this.setGrabbed(false);
        };

        this._mouseLeave = () => {
            if (this.manipulating) {
                this.setGrabbed(false);
            }
            if (this.hovered) {
                this.onUnhover(this.hovered);
                this.hovered = null;
            }
        };

        domElement.addEventListener('mousedown', this._mouseDown);
        domElement.addEventListener('mousemove', this._mouseMove);
        domElement.addEventListener('mouseup', this._mouseUp);
        domElement.addEventListener('mouseleave', this._mouseLeave);
    }

    getRevoluteDelta(joint, startPoint, endPoint) {
        const { camera, initialGrabPoint } = this;

        const jointObj = this.getJointThreeObject(joint);
        if (!jointObj) return 0;

        const axis = this.getJointAxis(joint);

        tempVector
            .copy(axis)
            .transformDirection(jointObj.matrixWorld)
            .normalize();
        pivotPoint
            .set(0, 0, 0)
            .applyMatrix4(jointObj.matrixWorld);
        plane
            .setFromNormalAndCoplanarPoint(tempVector, pivotPoint);

        tempVector
            .copy(camera.position)
            .sub(initialGrabPoint)
            .normalize();

        // if looking into the plane of rotation
        if (Math.abs(tempVector.dot(plane.normal)) > 0.3) {
            return super.getRevoluteDelta(joint, startPoint, endPoint);
        } else {
            // get the up direction
            tempVector.set(0, 1, 0).transformDirection(camera.matrixWorld);

            // get points projected onto the plane of rotation
            plane.projectPoint(startPoint, projectedStartPoint);
            plane.projectPoint(endPoint, projectedEndPoint);

            tempVector.set(0, 0, -1).transformDirection(camera.matrixWorld);
            tempVector.cross(plane.normal);
            tempVector2.subVectors(endPoint, startPoint);

            return tempVector.dot(tempVector2);
        }
    }

    dispose() {
        const { domElement } = this;
        domElement.removeEventListener('mousedown', this._mouseDown);
        domElement.removeEventListener('mousemove', this._mouseMove);
        domElement.removeEventListener('mouseup', this._mouseUp);
        domElement.removeEventListener('mouseleave', this._mouseLeave);
    }
}

// For backward compatibility, export old names
export { JointDragControls as URDFDragControls, PointerJointDragControls as PointerURDFDragControls };

