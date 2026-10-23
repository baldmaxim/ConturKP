import * as THREE from 'three';
import { OFFICE_ROLES, ROLE_TITLE, shirtIndex, type IOfficeModel, type TOfficePose, type TOfficeRole } from './officeModel';

export interface IOfficeSceneProps { office: IOfficeModel; selectedRole: TOfficeRole; frozen: boolean; onSelect: (role: TOfficeRole) => void }
export interface IOfficeSceneController { update: (props: IOfficeSceneProps) => void; dispose: () => void }
interface IAgent { left: THREE.Group; right: THREE.Group; working: boolean; pose: TOfficePose; phase: number }

/** Процедурная модель без внешних ассетов и запросов: палитра целиком из токенов активной темы. */
export const mountOfficeScene = (canvas: HTMLCanvasElement, initial: IOfficeSceneProps, onUnavailable: () => void): IOfficeSceneController => {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const content = new THREE.Group();
  scene.add(content);
  const camera = new THREE.OrthographicCamera(-16, 16, 12, -12, .1, 150);
  camera.position.set(27, 27, 34);
  camera.lookAt(0, 1.8, 0);
  camera.updateMatrixWorld();
  const ambient = new THREE.AmbientLight('white', 2);
  const sun = new THREE.DirectionalLight('white', 2.2);
  sun.position.set(-8, 18, 12);
  scene.add(ambient, sun);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const materials = new Map<string, THREE.MeshLambertMaterial>();
  let props = initial;
  let agents: IAgent[] = [];
  let animation = 0;
  let lastFrame = 0;
  let inView = true;
  let disposed = false;
  let lost = false;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  const tokenColor = (token: string): THREE.Color => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    return new THREE.Color(value || getComputedStyle(canvas).color);
  };
  const material = (token: string): THREE.MeshLambertMaterial => {
    let current = materials.get(token);
    if (!current) { current = new THREE.MeshLambertMaterial({ color: tokenColor(token) }); materials.set(token, current); }
    return current;
  };
  const box = (parent: THREE.Object3D, x: number, y: number, z: number, w: number, h: number, d: number, token: string, role?: TOfficeRole): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material(token));
    mesh.position.set(x, y, z);
    mesh.scale.set(w, h, d);
    if (role) mesh.userData.role = role;
    parent.add(mesh);
    return mesh;
  };
  const person = (x: number, z: number, role: TOfficeRole, working: boolean, alarm: boolean, phase: number, pose: TOfficePose = 'idle'): void => {
    const group = new THREE.Group();
    group.position.set(x, .05, z);
    content.add(group);
    const shirt = `--office-shirt-${shirtIndex(role)}`;
    box(group, -.17, .36, 0, .27, .65, .34, '--office-pants', role);
    box(group, .17, .36, 0, .27, .65, .34, '--office-pants', role);
    box(group, -.17, .08, .08, .3, .16, .5, '--office-monitor', role);
    box(group, .17, .08, .08, .3, .16, .5, '--office-monitor', role);
    box(group, 0, 1.03, 0, .76, .8, .45, shirt, role);
    box(group, 0, 1.82, 0, .84, .79, .7, '--office-skin', role);
    box(group, 0, 2.17, -.02, .9, .23, .75, '--office-hair', role);
    box(group, -.36, 1.9, -.13, .16, .55, .5, '--office-hair', role);
    for (const eye of [-.18, .18]) box(group, eye, 1.82, .36, .1, .11, .03, '--office-screen', role);
    box(group, 0, 1.6, .36, .19, .04, .03, '--office-hair', role);
    const arm = (side: number): THREE.Group => {
      const pivot = new THREE.Group();pivot.position.set(side * .54, 1.35, 0);group.add(pivot);
      box(pivot, 0, -.3, 0, .27, .6, .34, shirt, role);
      box(pivot, 0, -.66, 0, .27, .2, .34, '--office-skin', role);
      return pivot;
    };
    const left = arm(-1), right = arm(1);
    if (alarm) {
      right.rotation.z = Math.PI;
      box(group, .6, 2.9, 0, .48, .48, .15, '--warning', role);
      box(group, .6, 2.97, .08, .07, .2, .02, '--surface', role);
      box(group, .6, 2.76, .08, .07, .06, .02, '--surface', role);
    } else if (pose === 'read') {
      box(group, 0, 1.02, .58, .75, .58, .06, '--office-cup', role);
      left.rotation.x = right.rotation.x = -.9;
    } else if (pose === 'think') {
      right.rotation.x = -2.1;
      right.rotation.z = -.3;
    } else if (!working) {
      box(group, -.65, .8, .26, .26, .34, .26, '--office-cup', role);
    }
    agents.push({ left, right, working, pose, phase });
  };

  const populate = (): void => {
    content.clear();agents = [];
    box(content, 0, -.3, 0, 23.5, .6, 21, '--office-desk');
    box(content, 0, .02, 0, 23.5, .05, 21, '--surface-2');
    box(content, 0, 2, -10.4, 23.5, 4, .22, '--office-bubble');
    box(content, -11.65, 2, 0, .22, 4, 21, '--office-bubble');
    for (let x = -11; x < 12; x += 1.4) box(content, x, .06, 0, .018, .02, 20.8, '--border-subtle');
    for (let z = -10; z < 11; z += 1.4) box(content, 0, .06, z, 23.3, .02, .018, '--border-subtle');
    // Доска, книжный шкаф, растения и диван комнаты отдыха.
    box(content, -7, 2.8, -10.23, 3.6, 1.8, .12, '--surface');
    box(content, -7, 2.8, -10.13, 2.5, .07, .05, '--accent');
    box(content, 6, 1.35, -9.9, 5.2, 2.7, .65, '--office-desk');
    for (let i = 0; i < 9; i++) box(content, 3.9 + i * .5, 1.7, -9.5, .3, 1.25, .35, i % 2 ? '--accent' : '--office-pants');
    for (const [x, z] of [[-10.3, 6.2], [10.4, -8.8]]) {
      box(content, x!, .45, z!, .9, .9, .9, '--office-desk');
      box(content, x!, 1.4, z!, .12, 1.6, .12, '--office-shirt-2');
      box(content, x! - .2, 1.9, z!, 1.2, .8, 1, '--office-shirt-2');
      box(content, x! + .2, 2.4, z!, 1, 1, 1, '--office-shirt-2');
    }
    box(content, 6.2, .55, 9, 5.2, 1.1, 1.7, '--office-sofa');
    box(content, 6.2, 1.25, 8.35, 5.2, 1.1, .45, '--office-sofa');
    for (const x of [3.8, 8.6]) box(content, x, .95, 9, .45, 1.5, 1.8, '--office-sofa');
    const roles = OFFICE_ROLES.filter((role) => role !== 'other' || props.office.desks.some((d) => d.role === role) || props.office.lounge.some((r) => r.role === role));
    const columns = roles.length > 9 ? 4 : 3;
    let resting = 0;
    roles.forEach((role, index) => {
      const x = (index % columns - (columns - 1) / 2) * (columns === 4 ? 5.2 : 6.5), z = Math.floor(index / columns) * 5 - 6;
      const desk = props.office.desks.find((item) => item.role === role);
      const working = desk?.mood === 'working', alarm = desk?.mood === 'alarm';
      if (role === props.selectedRole) box(content, x, .1, z, 5.5, .07, 4.2, '--accent-soft', role);
      box(content, x, 1.3, z, 4.1, .25, 2.2, '--office-desk', role);
      for (const dx of [-1.7, 1.7]) for (const dz of [-.8, .8]) box(content, x + dx, .65, z + dz, .18, 1.3, .18, '--office-monitor', role);
      box(content, x + .5, 2.4, z + .12, 1.65, 1.5, .18, '--office-monitor', role);
      box(content, x + .5, 2.4, z + .22, 1.4, 1.2, .04, '--office-screen', role);
      box(content, x + .5, 1.6, z + .1, .2, .6, .2, '--office-monitor', role);
      box(content, x + .4, 1.47, z + .85, 1.1, .06, .38, '--office-monitor', role);
      if (working) for (let line = 0; line < 3; line++) box(content, x + .2 + line * .08, 2.7 - line * .25, z + .25, .7, .045, .02, '--office-screen-glow', role);
      if (desk) person(x - 1.9, z - .25, role, working, alarm, index, desk.pose);
      else { person(-8.8 + (resting % 6) * 1.7, 8.6 + Math.floor(resting / 6) * 1.3, role, false, false, index); resting++; }
    });
    resize();
  };

  const render = (): void => { if (!disposed && !lost) renderer.render(scene, camera); };
  const resize = (): void => {
    if (disposed || lost) return;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    const bounds = new THREE.Box3().setFromObject(content);
    const corners: THREE.Vector3[] = [];
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) corners.push(new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse));
    const minX = Math.min(...corners.map((v) => v.x)), maxX = Math.max(...corners.map((v) => v.x));
    const minY = Math.min(...corners.map((v) => v.y)), maxY = Math.max(...corners.map((v) => v.y));
    const aspect = width / height, halfHeight = Math.max((maxY - minY) / 2, (maxX - minX) / (2 * aspect)) * 1.04;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    camera.left = cx - halfHeight * aspect;camera.right = cx + halfHeight * aspect;camera.top = cy + halfHeight;camera.bottom = cy - halfHeight;
    camera.updateProjectionMatrix();render();
  };
  const shouldAnimate = (): boolean => !disposed && !lost && !props.frozen && agents.some((agent) => agent.working) && !motion.matches && inView && document.visibilityState === 'visible';
  const frame = (time: number): void => {
    animation = 0;
    if (!shouldAnimate()) return;
    if (time - lastFrame > 1000 / 24) {
      lastFrame = time;
      for (const agent of agents) if (agent.working && agent.pose !== 'read' && agent.pose !== 'think') { agent.left.rotation.x = -.35 + Math.sin(time / 120 + agent.phase) * .17;agent.right.rotation.x = -.35 - Math.sin(time / 120 + agent.phase) * .17; }
      render();
    }
    animation = requestAnimationFrame(frame);
  };
  const syncAnimation = (): void => { cancelAnimationFrame(animation);animation = 0;if (shouldAnimate()) animation = requestAnimationFrame(frame);else render(); };
  const hit = (event: PointerEvent): TOfficeRole | undefined => {
    const rect = canvas.getBoundingClientRect();pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObject(content, true).find((result) => result.object.userData.role)?.object.userData.role as TOfficeRole | undefined;
  };
  const click = (event: PointerEvent): void => { const role = hit(event);if (role) props.onSelect(role); };
  const hover = (event: PointerEvent): void => { const role = hit(event);canvas.style.cursor = role ? 'pointer' : '';canvas.title = role ? ROLE_TITLE[role] : ''; };
  const onLost = (event: Event): void => { event.preventDefault();lost = true;cancelAnimationFrame(animation);onUnavailable(); };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  const intersection = new IntersectionObserver(([entry]) => { inView = entry?.isIntersecting ?? true;syncAnimation(); });
  intersection.observe(canvas);
  const theme = new MutationObserver(() => { for (const [token, current] of materials) current.color.copy(tokenColor(token));render(); });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  canvas.addEventListener('pointerup', click);canvas.addEventListener('pointermove', hover);canvas.addEventListener('webglcontextlost', onLost);
  document.addEventListener('visibilitychange', syncAnimation);motion.addEventListener('change', syncAnimation);
  populate();syncAnimation();
  return {
    update(next) { props = next;populate();syncAnimation(); },
    dispose() {
      disposed = true;cancelAnimationFrame(animation);resizeObserver.disconnect();intersection.disconnect();theme.disconnect();
      canvas.removeEventListener('pointerup', click);canvas.removeEventListener('pointermove', hover);canvas.removeEventListener('webglcontextlost', onLost);
      document.removeEventListener('visibilitychange', syncAnimation);motion.removeEventListener('change', syncAnimation);
      geometry.dispose();for (const current of materials.values()) current.dispose();renderer.dispose();scene.clear();
    },
  };
};
