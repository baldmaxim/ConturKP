import * as THREE from 'three';
import { OFFICE_ROLES, idleActivity, shirtIndex, type IOfficeModel, type TIdleActivity, type TOfficePose, type TOfficeRole } from './officeModel';
import { advanceOfficeSeating, advanceOfficeWalk, computerSeat, createOfficeWalk, deskPosition, pointOnOfficeWalk, type IOfficeWalk } from './officeMovement';
import type { IOfficeAgentAnchor } from './officeAlerts';
import { officeComputer } from './officeExecution';

export interface IOfficeSceneProps { office: IOfficeModel; selectedRole: TOfficeRole; frozen: boolean; stale: boolean; onSelect: (role: TOfficeRole) => void; onAnchors?: (anchors: IOfficeAgentAnchor[]) => void; onHover?: (role: TOfficeRole | null) => void }
export interface IOfficeSceneController { update: (props: IOfficeSceneProps) => void; dispose: () => void }
interface ILeg { hip: THREE.Group; knee: THREE.Group }
interface IAgent {
  role: TOfficeRole; group: THREE.Group; left: THREE.Group; right: THREE.Group; legs: ILeg[];
  book: THREE.Group; cup: THREE.Group; phone: THREE.Group;
  walk: IOfficeWalk; activity: TIdleActivity; working: boolean; resting: boolean; pose: TOfficePose;
  phase: number; patrolBack: boolean; sit: number; elbows: THREE.Group[];
}

/** Комната и персонажи живут весь срок сцены. Опрос меняет цели движения, не создаёт их заново. */
export const mountOfficeScene = (canvas: HTMLCanvasElement, initial: IOfficeSceneProps, onUnavailable: () => void): IOfficeSceneController => {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene(), room = new THREE.Group(), people = new THREE.Group();scene.add(room, people);
  const camera = new THREE.OrthographicCamera(-20, 20, 16, -16, .1, 180);
  camera.position.set(34, 36, 47);camera.lookAt(0, 1.8, 3);camera.updateMatrixWorld();
  const sun = new THREE.DirectionalLight('white', 2.2);sun.position.set(-8, 24, 16);
  scene.add(new THREE.AmbientLight('white', 2), sun);
  const geometry = new THREE.BoxGeometry(1, 1, 1), materials = new Map<string, THREE.MeshLambertMaterial>();
  const agents: IAgent[] = [], stations = new Map<TOfficeRole, { highlight: THREE.Mesh; glow: THREE.Group }>();
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const palette = document.createElement('canvas');palette.width = palette.height = 1;
  const paletteContext = palette.getContext('2d', { willReadFrequently: true });
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  let props = initial, animation = 0, lastFrame = 0, inView = true, disposed = false, lost = false;
  const tokenColor = (token: string): THREE.Color => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim() || getComputedStyle(canvas).color;
    if (!paletteContext) return new THREE.Color(value);
    // Браузер разрешает color-mix() и color(srgb ...), которые THREE.Color не разбирает.
    paletteContext.clearRect(0, 0, 1, 1);paletteContext.fillStyle = value;paletteContext.fillRect(0, 0, 1, 1);
    const rgba = paletteContext.getImageData(0, 0, 1, 1).data;
    return new THREE.Color().setRGB(rgba[0]! / 255, rgba[1]! / 255, rgba[2]! / 255, THREE.SRGBColorSpace);
  };
  const material = (token: string): THREE.MeshLambertMaterial => {
    let current = materials.get(token);
    if (!current) { current = new THREE.MeshLambertMaterial({ color: tokenColor(token) });materials.set(token, current); }
    return current;
  };
  const box = (parent: THREE.Object3D, x: number, y: number, z: number, w: number, h: number, d: number, token: string, role?: TOfficeRole): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material(token));mesh.position.set(x, y, z);mesh.scale.set(w, h, d);
    if (role) mesh.userData.role = role;parent.add(mesh);return mesh;
  };
  const plant = (x: number, z: number): void => {
    box(room, x, .4, z, .9, .8, .9, '--office-desk');box(room, x, 1.35, z, .12, 1.5, .12, '--office-shirt-2');
    box(room, x - .2, 1.8, z, 1.2, .8, 1, '--office-shirt-2');box(room, x + .2, 2.3, z, 1, 1, 1, '--office-shirt-2');
  };
  const sofa = (x: number, z: number, width: number): void => {
    box(room, x, .55, z, width, .55, 1.8, '--office-sofa');box(room, x, 1.15, z - .8, width, 1.3, .35, '--office-sofa');
    for (const dx of [-width / 2 + .2, width / 2 - .2]) box(room, x + dx, .9, z, .4, 1, 2, '--office-sofa');
    for (let dx = -width / 2 + 1; dx < width / 2 - .4; dx += 1.5) box(room, x + dx, .86, z + .05, 1.4, .12, 1.45, '--office-bubble');
  };
  const table = (x: number, z: number, width: number, depth: number): void => {
    box(room, x, 1.05, z, width, .18, depth, '--office-desk');
    for (const dx of [-width / 2 + .2, width / 2 - .2]) for (const dz of [-depth / 2 + .2, depth / 2 - .2]) box(room, x + dx, .5, z + dz, .16, 1, .16, '--office-monitor');
  };
  const buildRoom = (): void => {
    box(room, 0, -.3, 3.5, 32.5, .6, 31.5, '--office-desk');box(room, 0, .02, 3.5, 32.5, .05, 31.5, '--surface-2');
    box(room, 0, 2, -12.15, 32.5, 4, .22, '--office-bubble');box(room, -16.15, 2, 3.5, .22, 4, 31.5, '--office-bubble');
    for (let x = -16; x < 17; x += 1.4) box(room, x, .06, 3.5, .018, .02, 31.3, '--border-subtle');
    for (let z = -12; z < 20; z += 1.4) box(room, 0, .06, z, 32.3, .02, .018, '--border-subtle');
    box(room, -8, 2.8, -11.98, 5, 1.8, .12, '--surface');box(room, -8, 2.8, -11.88, 3.5, .07, .05, '--accent');
    box(room, 7, 1.35, -11.7, 6, 2.7, .65, '--office-desk');
    for (let i = 0; i < 11; i++) box(room, 4.5 + i * .5, 1.7, -11.3, .3, 1.25, .35, i % 2 ? '--accent' : '--office-pants');
    plant(-14.5, -10);plant(14.8, -10);plant(14.8, 17.4);
    // Зона отдыха отделена перегородкой с широким проходом. Мебель не перекрывает маршруты.
    box(room, 0, .08, 14, 31.4, .06, 9.6, '--office-floor');
    for (const x of [-9.2, 9.2]) { box(room, x, .62, 9, 13.7, 1.2, .25, '--office-bubble');box(room, x, 1.27, 9, 13.7, .1, .32, '--office-desk'); }
    box(room, 8.8, .13, 15.1, 11, .04, 7, '--accent-soft');sofa(9, 12.5, 9);sofa(3.3, 16.5, 2);
    table(9, 15.8, 3.2, 1.3);box(room, 8.5, 1.2, 15.8, .8, .1, .55, '--office-shirt-4');box(room, 9.6, 1.28, 15.8, .25, .35, .25, '--office-cup');
    table(-9.2, 13.7, 3.2, 2.2);
    for (const [x, z] of [[-10, 13.5], [-8.8, 14]]) box(room, x!, 1.3, z!, .25, .3, .25, '--office-cup');
    box(room, -14.5, .9, 13.3, 1.7, 1.8, 5.2, '--office-desk');box(room, -14.5, 2.25, 12.2, 1.1, .9, 1.1, '--office-monitor');
    box(room, -14.45, 2.25, 12.78, .6, .3, .04, '--accent');box(room, -14.5, 1.9, 13.4, .5, .15, .5, '--office-cup');plant(-14.5, 17.2);
    for (const role of OFFICE_ROLES) {
      const { x, z } = deskPosition(role);
      const highlight = box(room, x, .1, z, 5.5, .07, 4.2, '--accent-soft', role), station = new THREE.Group();room.add(station);
      box(station, x, 1.12, z, 4.1, .25, 2.2, '--office-desk', role);
      for (const dx of [-1.7, 1.7]) for (const dz of [-.8, .8]) box(station, x + dx, .5, z + dz, .18, 1, .18, '--office-monitor', role);
      box(station, x + .5, 2.05, z + .12, 1.65, 1.2, .18, '--office-monitor', role);box(station, x + .5, 2.05, z + .22, 1.4, .98, .04, '--office-screen', role);
      box(station, x + .5, 1.4, z + .1, .2, .55, .2, '--office-monitor', role);box(station, x + .4, 1.29, z + .9, 1.25, .06, .45, '--office-monitor', role);
      const chair = computerSeat(role);
      box(station, chair.x, .64, chair.z, 1.15, .18, 1, '--office-sofa', role);
      box(station, chair.x, 1.12, chair.z + .37, 1.1, .82, .18, '--office-sofa', role);
      box(station, chair.x, .3, chair.z, .16, .6, .16, '--office-monitor', role);
      box(station, chair.x, .12, chair.z, 1.2, .12, .18, '--office-monitor', role);box(station, chair.x, .12, chair.z, .18, .12, 1.1, '--office-monitor', role);
      // Опора под короткие пиксельные ноги, чтобы ступни не висели в воздухе.
      box(station, chair.x, .42, chair.z - .45, .95, .06, .48, '--office-monitor', role);
      const glow = new THREE.Group();station.add(glow);
      for (let line = 0; line < 3; line++) box(glow, x + .2 + line * .08, 2.34 - line * .18, z + .25, .7, .045, .02, '--office-screen-glow', role);
      stations.set(role, { highlight, glow });
    }
  };
  const person = (role: TOfficeRole, phase: number): IAgent => {
    const group = new THREE.Group();people.add(group);const shirt = `--office-shirt-${shirtIndex(role)}`;
    const leg = (side: number): ILeg => {
      const hip = new THREE.Group(), knee = new THREE.Group();hip.position.set(side * .18, .75, 0);group.add(hip);
      box(hip, 0, -.18, 0, .27, .36, .34, '--office-pants', role);knee.position.y = -.36;hip.add(knee);
      box(knee, 0, -.15, 0, .27, .3, .34, '--office-pants', role);box(knee, 0, -.32, .08, .3, .16, .5, '--office-monitor', role);return { hip, knee };
    };
    const legs = [leg(-1), leg(1)];
    box(group, 0, 1.03, 0, .76, .8, .45, shirt, role);box(group, 0, 1.82, 0, .84, .79, .7, '--office-skin', role);
    box(group, 0, 2.17, -.02, .9, .23, .75, '--office-hair', role);box(group, -.36, 1.9, -.13, .16, .55, .5, '--office-hair', role);
    for (const eye of [-.18, .18]) box(group, eye, 1.82, .36, .1, .11, .03, '--office-screen', role);
    box(group, 0, 1.6, .36, .19, .04, .03, '--office-hair', role);
    const elbows: THREE.Group[] = [];
    const arm = (side: number): THREE.Group => {
      const pivot = new THREE.Group();pivot.position.set(side * .54, 1.35, 0);group.add(pivot);
      box(pivot, 0, -.21, 0, .27, .42, .3, shirt, role);
      const elbow = new THREE.Group();elbow.position.y = -.42;pivot.add(elbow);elbows.push(elbow);
      box(elbow, 0, -.17, 0, .25, .34, .26, shirt, role);box(elbow, 0, -.39, 0, .27, .18, .22, '--office-skin', role);return pivot;
    };
    const left = arm(-1), right = arm(1);
    const book = new THREE.Group();group.add(book);box(book, 0, 1.02, .58, .75, .58, .06, '--office-cup', role);
    const cup = new THREE.Group();left.add(cup);box(cup, 0, -.7, .2, .26, .34, .26, '--office-cup', role);
    const phone = new THREE.Group();left.add(phone);box(phone, 0, -.7, .16, .28, .42, .06, '--office-monitor', role);box(phone, 0, -.7, .2, .2, .31, .02, '--accent', role);
    return { role, group, left, right, legs, book, cup, phone, walk: createOfficeWalk(role), activity: idleActivity(role), working: false, resting: false, pose: 'idle', phase, patrolBack: false, sit: -1, elbows };
  };
  const updateAgents = (): void => {
    for (const agent of agents) {
      const desk = props.office.desks.find((item) => item.role === agent.role), resident = props.office.lounge.find((item) => item.role === agent.role), person = desk ?? resident;
      const computer = person ? officeComputer(person, props.office.totals.workersAlive, props.stale) : 'off';
      agent.group.visible = !!person;agent.resting = !desk;agent.working = computer === 'working';agent.pose = desk?.pose ?? 'idle';
      const station = stations.get(agent.role)!;station.highlight.visible = !!person && props.selectedRole === agent.role;station.glow.visible = computer !== 'off';
      const token = computer === 'working' ? '--office-screen-glow' : computer === 'attention' ? '--danger' : computer === 'waiting' ? '--warning' : '--muted';
      for (const line of station.glow.children) (line as THREE.Mesh).material = material(token);
      if (motion.matches) agent.walk.distance = agent.resting ? agent.walk.length : 0;
    }
  };
  const drawAgent = (agent: IAgent, seconds: number, time: number): void => {
    if (!agent.group.visible) return;
    const before = pointOnOfficeWalk(agent.walk);let target = agent.resting ? agent.walk.length : 0;
    if (agent.resting && agent.activity === 'walk') {
      if (agent.walk.distance >= agent.walk.length - .001) agent.patrolBack = true;
      if (agent.walk.distance <= agent.walk.length - 2.2) agent.patrolBack = false;
      target = agent.patrolBack ? agent.walk.length - 2.2 : agent.walk.length;
    }
    const wantsToWalk = Math.abs(target - agent.walk.distance) > .001;
    const atComputer = !agent.resting && !wantsToWalk;
    agent.sit = agent.sit < 0 || motion.matches ? Number(atComputer) : advanceOfficeSeating(agent.sit, atComputer, seconds);
    // Сначала встать; кресло не уезжает вместе с персонажем и проход не начинается сидя.
    const moved = seconds > 0 && agent.sit < .001 && advanceOfficeWalk(agent.walk, target, seconds), walking = moved || wantsToWalk;
    const point = pointOnOfficeWalk(agent.walk);
    const wave = Math.sin(time / 160 + agent.phase), slow = Math.sin(time / 1100 + agent.phase);
    agent.group.position.set(point.x, .05 + agent.sit * .05 + (walking ? Math.abs(wave) * .07 * (1 - agent.sit) : 0), point.z);
    const restingSeat = agent.resting && !walking && (agent.activity === 'sofa' || agent.activity === 'phone');
    const seated = restingSeat ? 1 : agent.sit;
    const yaw = walking ? moved ? Math.atan2(point.x - before.x, point.z - before.z) : agent.group.rotation.y : atComputer ? Math.PI : agent.resting && agent.activity === 'coffee' ? agent.role === 'assembler' ? Math.PI / 2 : Math.PI : 0;
    const turn = Math.atan2(Math.sin(yaw - agent.group.rotation.y), Math.cos(yaw - agent.group.rotation.y));agent.group.rotation.y += seconds ? Math.max(-seconds * 7, Math.min(seconds * 7, turn)) : turn;
    agent.left.rotation.set(0, 0, 0);agent.right.rotation.set(0, 0, 0);
    agent.elbows.forEach(elbow => { elbow.rotation.x = -.5 * agent.sit; });
    agent.legs.forEach((leg, i) => { leg.hip.rotation.x = (walking ? wave * (i ? -.6 : .6) * (1 - seated) : 0) - Math.PI / 2 * seated;leg.knee.rotation.x = Math.PI / 2 * seated; });
    agent.book.visible = !walking && !agent.resting && !agent.working && agent.sit < .1 && agent.pose === 'read';agent.cup.visible = !walking && agent.resting && agent.activity === 'coffee';agent.phone.visible = !walking && agent.resting && agent.activity === 'phone';
    if (walking) { agent.left.rotation.x = -wave * .55 * (1 - agent.sit) - 1.25 * agent.sit;agent.right.rotation.x = wave * .55 * (1 - agent.sit) - 1.25 * agent.sit; }
    else if (agent.resting) {
      if (restingSeat) { agent.group.position.y = -.1;agent.left.rotation.x = -.55;agent.right.rotation.x = -.45; }
      if (agent.activity === 'coffee') agent.left.rotation.x = -1 + slow * .45;
      if (agent.activity === 'phone') agent.left.rotation.x = -1.15 + slow * .08;
      if (agent.activity === 'stretch') { agent.left.rotation.z = -2.5 + slow * .25;agent.right.rotation.z = 2.5 - slow * .25; }
    } else if (agent.sit > 0) {
      const typing = agent.working && !props.frozen && !motion.matches ? wave * .035 : 0;
      agent.left.rotation.x = (-1.25 + typing) * agent.sit;agent.right.rotation.x = (-1.25 - typing) * agent.sit;
    } else if (agent.pose === 'read') agent.left.rotation.x = agent.right.rotation.x = -.9;
    else if (agent.pose === 'think') { agent.right.rotation.x = -2.1;agent.right.rotation.z = -.3; }
    else if (agent.working) { agent.left.rotation.x = -.35 + wave * .17;agent.right.rotation.x = -.35 - wave * .17; }
  };
  const head = new THREE.Vector3();
  const render = (): void => {
    if (disposed || lost) return;
    renderer.render(scene, camera);
    props.onAnchors?.(agents.filter((agent) => agent.group.visible).map((agent) => {
      head.copy(agent.group.position);head.y += 2.5;head.project(camera);
      return { role: agent.role, x: (head.x + 1) * canvas.clientWidth / 2, y: (1 - head.y) * canvas.clientHeight / 2 };
    }));
  };
  const resize = (): void => {
    if (disposed || lost || !canvas.clientWidth || !canvas.clientHeight) return;
    const width = canvas.clientWidth, height = canvas.clientHeight;renderer.setSize(width, height, false);
    const bounds = new THREE.Box3().setFromObject(room), corners: THREE.Vector3[] = [];
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) corners.push(new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse));
    const minX = Math.min(...corners.map((v) => v.x)), maxX = Math.max(...corners.map((v) => v.x)), minY = Math.min(...corners.map((v) => v.y)), maxY = Math.max(...corners.map((v) => v.y));
    const aspect = width / height, halfHeight = Math.max((maxY - minY) / 2, (maxX - minX) / (2 * aspect)) * 1.04, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    camera.left = cx - halfHeight * aspect;camera.right = cx + halfHeight * aspect;camera.top = cy + halfHeight;camera.bottom = cy - halfHeight;camera.updateProjectionMatrix();render();
  };
  const shouldAnimate = (): boolean => !disposed && !lost && !props.frozen && !motion.matches && inView && document.visibilityState === 'visible';
  const frame = (time: number): void => {
    animation = 0;if (!shouldAnimate()) return;
    if (time - lastFrame >= 1000 / 24) {
      const seconds = Math.min((time - lastFrame) / 1000, .1);lastFrame = time;
      for (const agent of agents) drawAgent(agent, seconds, time);render();
    }
    animation = requestAnimationFrame(frame);
  };
  const syncAnimation = (): void => {
    cancelAnimationFrame(animation);animation = 0;lastFrame = performance.now();
    for (const agent of agents) drawAgent(agent, 0, motion.matches ? 0 : lastFrame);render();
    if (shouldAnimate()) animation = requestAnimationFrame(frame);
  };
  const hit = (event: PointerEvent, charactersOnly = false): TOfficeRole | undefined => {
    const rect = canvas.getBoundingClientRect();pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(charactersOnly ? [people] : [room, people], true).find((result) => result.object.userData.role)?.object.userData.role as TOfficeRole | undefined;
  };
  const click = (event: PointerEvent): void => { const role = hit(event);if (role) props.onSelect(role); };
  const hover = (event: PointerEvent): void => { const role = hit(event, true);canvas.style.cursor = role || hit(event) ? 'pointer' : '';props.onHover?.(role ?? null); };
  const leave = (): void => { canvas.style.cursor = '';props.onHover?.(null); };
  const onLost = (event: Event): void => { event.preventDefault();lost = true;cancelAnimationFrame(animation);onUnavailable(); };
  buildRoom();for (const [index, role] of OFFICE_ROLES.entries()) agents.push(person(role, index));updateAgents();
  const resizeObserver = new ResizeObserver(resize);resizeObserver.observe(canvas);
  const intersection = new IntersectionObserver(([entry]) => { inView = entry?.isIntersecting ?? true;syncAnimation(); });intersection.observe(canvas);
  const theme = new MutationObserver(() => { for (const [token, current] of materials) current.color.copy(tokenColor(token));render(); });theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const onMotion = (): void => { updateAgents();syncAnimation(); };
  canvas.addEventListener('pointerup', click);canvas.addEventListener('pointermove', hover);canvas.addEventListener('pointerleave', leave);canvas.addEventListener('webglcontextlost', onLost);
  document.addEventListener('visibilitychange', syncAnimation);motion.addEventListener('change', onMotion);resize();syncAnimation();
  return {
    update(next) { props = next;updateAgents();syncAnimation(); },
    dispose() {
      disposed = true;cancelAnimationFrame(animation);resizeObserver.disconnect();intersection.disconnect();theme.disconnect();
      canvas.removeEventListener('pointerup', click);canvas.removeEventListener('pointermove', hover);canvas.removeEventListener('pointerleave', leave);canvas.removeEventListener('webglcontextlost', onLost);
      document.removeEventListener('visibilitychange', syncAnimation);motion.removeEventListener('change', onMotion);
      geometry.dispose();for (const current of materials.values()) current.dispose();renderer.dispose();scene.clear();
    },
  };
};
