// avatar3d.js - 3D MMD avatar renderer for voice-chat tiles.
//
// This is a trimmed-down, multi-instance version of the standalone
// avatar.js example: instead of one big scene with OrbitControls, each
// voice-tile gets its own small self-contained instance (own scene, camera,
// renderer, render loop) sized to fill whatever container it's given -
// namely the 96x96 circular ring in a .voice-tile.
//
// Exposed as window.Avatar3D so the rest of the app (plain <script> files,
// no bundler) can call it without import syntax.

import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

function createAvatar3D(container, options = {}) {
    const {
        modelUrl,
        onReady = () => {},
        onError = () => {},
        // Interactive drag-to-rotate, right-drag/two-finger-to-pan,
        // scroll/pinch-to-zoom framing. Off by default: the voice-chat
        // tiles are tiny 96x96 rings and shouldn't eat mouse input from the
        // rest of the UI. Turn on for the Edit Profile preview so the user
        // can frame their model.
        controls: controlsEnabled = false,
        // Decorative idle sway - only makes sense when nobody's manually
        // framing the shot. Defaults to whatever controls isn't doing.
        autoRotate: autoRotateEnabled = !controlsEnabled,
        // Saved framing: zoom is a camera-distance multiplier (1 = default,
        // <1 = closer/bigger, >1 = further/smaller); offsetX/offsetY pan the
        // framing target left/right/up/down in world units; rotationY spins
        // the model horizontally (radians) so a different side faces the
        // camera. Vertical tilt is intentionally not exposed. These are what
        // gets persisted to the user's profile so every place the model
        // renders (voice tiles, other people's screens) uses the same crop
        // the user chose in Edit Profile.
        zoom: initialZoom = 1,
        offsetX: initialOffsetX = 0,
        offsetY: initialOffsetY = 0,
        rotationY: initialRotationY = 0,
        // Fired whenever the user finishes a drag/scroll gesture (controls
        // must be enabled), with the resulting { zoom, offsetX, offsetY, rotationY } -
        // so the caller can save it.
        onFramingChange = () => {},
    } = options;

    // Update CONFIG in createAvatar3D
    // In createAvatar3D, update CONFIG:
    const CONFIG = {
        startThreshold: 5,
        maxThreshold: 59,
        mouthLimit: 0.5,
        blinkIntervalMin: 2,
        blinkIntervalMax: 4,
        cameraPosition: options.cameraPosition || [0, 1.0, 2.5], // Closer
        cameraTarget: options.cameraTarget || [0, 0.5, 0],
        modelPosition: options.modelPosition || [0, -0.5, 0],
        autoRotateSpeed: 0.25,
    };

    // Same clamp range as the server (server/routes/auth.js) so what the
    // user sees while dragging matches what will actually be saved.
    const ZOOM_MIN = 0.3, ZOOM_MAX = 3, OFFSET_MAX = 2;
    let zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, initialZoom));
    let offsetX = Math.min(OFFSET_MAX, Math.max(-OFFSET_MAX, initialOffsetX));
    let offsetY = Math.min(OFFSET_MAX, Math.max(-OFFSET_MAX, initialOffsetY));
    let rotationY = initialRotationY;
    let baseTarget, baseDistance, baseDirection, baseAzimuth, basePolar;

    let scene, camera, renderer, controls;
    let model = null;
    let mouthKeys = [];
    let blinkKeys = [];
    let targetMouth = 0;
    let isBlinking = false;
    let blinkTimer = 0;
    let isBlinkEnabled = true;
    let isReady = false;
    let disposed = false;
    let rafId = null;
    let lastTime = performance.now();

    function applyFraming() {
        // target = base target, panned by the saved/dragged offset
        const target = new THREE.Vector3(
            baseTarget.x + offsetX,
            baseTarget.y + offsetY,
            baseTarget.z
        );
        const offset = new THREE.Vector3().setFromSphericalCoords(
            baseDistance * zoom,
            basePolar,
            baseAzimuth + rotationY
        );
        camera.position.copy(target).add(offset);
        camera.lookAt(target);
        if (controls) controls.target.copy(target);
    }

    function initScene() {
        const width = container.clientWidth || 96;
        const height = container.clientHeight || 96;

        scene = new THREE.Scene();

        camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 50);

        // Base (unzoomed/uncentered/unrotated) camera rig, from CONFIG -
        // this used to be hardcoded here and CONFIG.cameraPosition/
        // cameraTarget were silently ignored, which is why passing a closer
        // cameraPosition never actually made the model bigger.
        const basePos = new THREE.Vector3(...CONFIG.cameraPosition);
        baseTarget = new THREE.Vector3(...CONFIG.cameraTarget);
        baseDirection = basePos.clone().sub(baseTarget);
        baseDistance = baseDirection.length() || 1;
        baseDirection.normalize();
        const baseSpherical = new THREE.Spherical().setFromVector3(baseDirection);
        baseAzimuth = baseSpherical.theta;
        basePolar = baseSpherical.phi;

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        container.appendChild(renderer.domElement);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.minDistance = baseDistance * ZOOM_MIN;
        controls.maxDistance = baseDistance * ZOOM_MAX;

        // "Frame the shot" controls, only when explicitly enabled by the
        // caller (the Edit Profile preview turns this on; voice-chat tiles
        // leave it off): left-drag/one-finger to rotate (spin left/right to
        // pick which side faces the camera), right-drag/two-finger to pan
        // (reposition), scroll/pinch to zoom. Vertical tilt is locked (min
        // and max polar angle pinned to the base angle) so rotating can't
        // flip the camera upside-down or under the model.
        controls.enabled = controlsEnabled;
        controls.enableRotate = controlsEnabled;
        controls.enableZoom = controlsEnabled;
        controls.enablePan = controlsEnabled;
        controls.minPolarAngle = basePolar;
        controls.maxPolarAngle = basePolar;
        controls.screenSpacePanning = true;
        controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
        controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

        applyFraming();
        controls.update();

        if (controlsEnabled) {
            const emitFramingChange = () => {
                zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, camera.position.distanceTo(controls.target) / baseDistance));
                offsetX = Math.min(OFFSET_MAX, Math.max(-OFFSET_MAX, controls.target.x - baseTarget.x));
                offsetY = Math.min(OFFSET_MAX, Math.max(-OFFSET_MAX, controls.target.y - baseTarget.y));
                rotationY = controls.getAzimuthalAngle() - baseAzimuth;
                onFramingChange({ zoom, offsetX, offsetY, rotationY });
            };
            // 'end' fires once when a drag/scroll gesture finishes - that's
            // the point to report the settled value back to the caller,
            // rather than spamming it on every intermediate frame.
            controls.addEventListener('end', emitFramingChange);
        }

        // Brighter lights to see the model
        const ambient = new THREE.AmbientLight(0xffffff, 0.8);
        scene.add(ambient);
        const main = new THREE.DirectionalLight(0xffffff, 1.5);
        main.position.set(2, 5, 3);
        scene.add(main);
        const fill = new THREE.DirectionalLight(0xaaccff, 0.8);
        fill.position.set(-3, 2, 2);
        scene.add(fill);

        // Add a grid helper to see the ground
        const gridHelper = new THREE.GridHelper(5, 10, 0x888888, 0x444444);
        scene.add(gridHelper);
    }

    function findShapeKeys(mesh) {
        const mouthNames = ['あ', 'い', 'う', 'え', 'お', 'a', 'i', 'u', 'e', 'o', 'mouth', 'open', '口', '開'];
        const blinkNames = ['blink', 'eye', '目', 'まばたき', 'closeeye', 'eyelid', 'wink'];

        const foundMouth = [], foundBlink = [];

        mesh.traverse((child) => {
            if (child.isMesh && child.morphTargetDictionary) {
                const dict = child.morphTargetDictionary;
                const inf = child.morphTargetInfluences;
                Object.keys(dict).forEach((key) => {
                    const lower = key.toLowerCase();
                    if (mouthNames.some((n) => lower.includes(n.toLowerCase()))) {
                        foundMouth.push({ index: dict[key], inf });
                    }
                    if (blinkNames.some((n) => lower.includes(n.toLowerCase()))) {
                        foundBlink.push({ index: dict[key], inf });
                    }
                });
            }
        });

        return { mouthKeys: foundMouth, blinkKeys: foundBlink };
    }

    function applyMouth(amount) {
        const limited = Math.min(amount, CONFIG.mouthLimit);
        mouthKeys.forEach((k) => { k.inf[k.index] = Math.max(0, Math.min(1, limited)); });
    }

    function applyBlink(amount) {
        blinkKeys.forEach((k) => { k.inf[k.index] = Math.max(0, Math.min(1, amount)); });
    }

    // In avatar3d.js, modify the loadModel function
    function loadModel() {
        const loader = new MMDLoader();
        
        // Use the model path directly - no setPath needed
        console.log('Loading model from:', modelUrl);
        
        loader.load(
            modelUrl,  // This should be the full path or relative path
            (mesh) => {
                if (disposed) return;
                console.log('✅ Model loaded successfully!', mesh);
                
                model = mesh;
                
                // Scale and position
                const targetHeight = 2.5;
                let currentHeight = 10.902268886566162;
                
                // Try to get actual height from bounding box
                try {
                    mesh.geometry.computeBoundingBox();
                    if (mesh.geometry.boundingBox) {
                        const box = mesh.geometry.boundingBox;
                        currentHeight = box.max.y - box.min.y;
                    }
                } catch (e) {}
                
                const scale = targetHeight / currentHeight;
                model.scale.set(scale, scale, scale);
                model.position.set(0, -0.5, 0);
                
                // Process materials - textures should load automatically.
                //
                // NOTE: `mat.map` being truthy only means a Texture object was
                // assigned - it does NOT mean the image behind it actually
                // loaded. If the underlying file 404s (e.g. a filename
                // encoding mismatch between what's on disk and what the PMX
                // references internally), `mat.map` stays a real, truthy
                // Texture pointing at a broken image, so this used to skip
                // the fallback tint entirely and just render black. We now
                // explicitly check whether the image behind the texture
                // loaded successfully, and also listen for late failures.
                function applyFallbackTint(mat) {
                    console.warn('⚠️ Texture failed to load, using fallback tint');
                    mat.map = null;
                    mat.color.setHex(0x88ccff);
                    mat.needsUpdate = true;
                }

                mesh.traverse((child) => {
                    if (child.isMesh) {
                        const materials = Array.isArray(child.material) ? child.material : [child.material];
                        materials.forEach(mat => {
                            if (mat.map) {
                                const img = mat.map.image;
                                const alreadyFailed = img && img.complete && img.naturalWidth === 0;

                                if (alreadyFailed) {
                                    applyFallbackTint(mat);
                                    return;
                                }

                                mat.map.encoding = THREE.sRGBEncoding;
                                mat.map.anisotropy = 4;
                                mat.map.needsUpdate = true;
                                mat.transparent = true;
                                mat.side = THREE.DoubleSide;
                                mat.needsUpdate = true;
                                console.log('✅ Texture found and applied');

                                // Image may still be in-flight (or may fail
                                // later than this synchronous check) - catch
                                // that case too.
                                if (img && !img.complete) {
                                    img.addEventListener('error', () => {
                                        if (disposed) return;
                                        applyFallbackTint(mat);
                                        renderer.render(scene, camera);
                                    }, { once: true });
                                }
                            } else {
                                console.warn('⚠️ No texture on mesh');
                                mat.color.setHex(0x88ccff);
                                mat.needsUpdate = true;
                            }
                        });
                    }
                });
                
                scene.add(model);
                
                const result = findShapeKeys(mesh);
                mouthKeys = result.mouthKeys;
                blinkKeys = result.blinkKeys;
                
                applyMouth(0);
                isReady = true;
                onReady();
                
                renderer.render(scene, camera);
            },
            (xhr) => {
                const progress = Math.round((xhr.loaded / xhr.total) * 100);
                console.log(`Loading progress: ${progress}%`);
            },
            (error) => {
                if (disposed) return;
                console.error('❌ Failed to load model:', error);
                console.error('File path:', modelUrl);
                onError(error);
            }
        );
    }

    function updateBlink(delta) {
        if (!isBlinkEnabled || blinkKeys.length === 0) {
            applyBlink(0);
            return;
        }
        if (!isBlinking) {
            if (blinkTimer <= 0) {
                blinkTimer = CONFIG.blinkIntervalMin + Math.random() * (CONFIG.blinkIntervalMax - CONFIG.blinkIntervalMin);
            }
            blinkTimer -= delta;
            if (blinkTimer <= 0) { isBlinking = true; blinkTimer = 0; }
        } else {
            const duration = 0.15;
            const elapsed = blinkTimer + delta;
            blinkTimer = elapsed;
            if (elapsed < duration * 0.4) {
                applyBlink(elapsed / (duration * 0.4));
            } else if (elapsed < duration * 0.6) {
                applyBlink(1);
            } else if (elapsed < duration) {
                applyBlink(1 - (elapsed - duration * 0.6) / (duration * 0.4));
            } else {
                isBlinking = false;
                blinkTimer = 0;
                applyBlink(0);
            }
        }
    }

    // voiceLevel is expected to be a 0-1 RMS-ish value (same scale voice.js
    // already computes for the speaking indicator).
    function updateMouth(voiceLevel, delta) {
        if (!isReady || mouthKeys.length === 0) return;

        const startNorm = CONFIG.startThreshold / 100;
        const maxNorm = CONFIG.maxThreshold / 100;
        const range = maxNorm - startNorm;

        let mouthVal = 0;
        if (voiceLevel > startNorm) {
            mouthVal = (voiceLevel - startNorm) / range;
            mouthVal = Math.max(0, Math.min(1, mouthVal));
            mouthVal = mouthVal * mouthVal * (3 - 2 * mouthVal);
        }

        if (mouthVal > targetMouth) {
            targetMouth = Math.min(targetMouth + (mouthVal - targetMouth) * 0.5, 1);
        } else {
            targetMouth = Math.max(targetMouth * 0.9, mouthVal * 0.9);
        }

        applyMouth(targetMouth);
    }

    let pendingVoiceLevel = 0;

    function loop() {
        if (disposed) return;
        rafId = requestAnimationFrame(loop);

        const now = performance.now();
        const delta = Math.min((now - lastTime) / 1000, 0.1);
        lastTime = now;

        if (isReady) {
            updateBlink(delta);
            updateMouth(pendingVoiceLevel, delta);
            if (autoRotateEnabled && model && CONFIG.autoRotateSpeed) {
                model.rotation.y = Math.sin(now / 4000) * 0.35;
            }
        }

        if (controls) controls.update();

        renderer.render(scene, camera);
    }

    const api = {
        setVoiceLevel(level) {
            pendingVoiceLevel = level || 0;
        },
        getFraming() {
            return { zoom, offsetX, offsetY, rotationY };
        },
        // Used by the zoom/rotate sliders / reset button - anything driving
        // framing outside of direct drag/scroll on the canvas itself.
        setFraming({ zoom: z, offsetX: ox, offsetY: oy, rotationY: ry } = {}) {
            if (z !== undefined) zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
            if (ox !== undefined) offsetX = Math.min(OFFSET_MAX, Math.max(-OFFSET_MAX, ox));
            if (oy !== undefined) offsetY = Math.min(OFFSET_MAX, Math.max(-OFFSET_MAX, oy));
            if (ry !== undefined) rotationY = ry;
            if (camera && baseTarget) {
                applyFraming();
                if (controls) controls.update();
                renderer.render(scene, camera);
            }
        },
        toggleBlink(enabled) {
            isBlinkEnabled = enabled !== undefined ? enabled : !isBlinkEnabled;
        },
        resize() {
            const width = container.clientWidth || 96;
            const height = container.clientHeight || 96;
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderer.setSize(width, height);
        },
        dispose() {
            disposed = true;
            if (rafId) cancelAnimationFrame(rafId);
            if (controls) controls.dispose();
            if (renderer) {
                renderer.dispose();
                if (renderer.domElement && renderer.domElement.parentNode) {
                    renderer.domElement.parentNode.removeChild(renderer.domElement);
                }
            }
        }
    };

    initScene();
    loadModel();
    rafId = requestAnimationFrame(loop);

    return api;
}

window.Avatar3D = { createAvatar: createAvatar3D };