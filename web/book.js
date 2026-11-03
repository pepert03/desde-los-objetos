import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// =====================================================================
//  Cuaderno A5 de tapa blanda. Unidades: milímetros. La mesa es el plano
//  y = 0; el lomo está sobre el eje z; las páginas de la derecha van hacia +x.
// =====================================================================

const W = 148, H = 210;
const THICK = { paper: .12, onion: .05, cover: .75 };
const PAPER = { paper: '#faf9f5', onion: '#f2f1ea', cover: '#fbfbf9' };
const ALPHA = { paper: 1, onion: .7, cover: 1 };
const THROUGH = { paper: .05, onion: .3, cover: .02 };   // cuánto se trasluce el reverso
const EDGE = { paper: '#efeee8', onion: '#d9d8cf', cover: '#fafaf8' };
const SEG = 72;                 // segmentos a lo largo del ancho de la hoja
const FLIP_MS = 1150;
const LEAD = .42;               // cuánto se adelanta el borde exterior al pasar la hoja
const TABLE = '#efeeeb';

// ---------------------------------------------------------------------
//  Hojas
// ---------------------------------------------------------------------
// Pliego N del PDF (A3 apaisado) = folio impar a la izquierda + folio par a la derecha.
const pad = n => String(n).padStart(2, '0');
const folio = (pdf, side) => pdf < 3 ? null : 2 * pdf - (side === 'L' ? 5 : 4);
const fromPdf = (pdf, side) => ({ src: `p${pad(pdf)}-${side}`, num: folio(pdf, side) });
const fromFolio = n => fromPdf(Math.floor((n + 5) / 2), n % 2 ? 'L' : 'R');
const BLANK = {};

const leaves = [];
const add = (kind, front, back) => leaves.push({ kind, front, back });

add('cover', { src: 'p01' }, BLANK);
for (let pdf = 2; pdf <= 22; pdf++) add('paper', fromPdf(pdf, 'R'), fromPdf(pdf + 1, 'L'));   // … 40 | 41
// Casos de estudio (41–84): cada foto va en papel cebolla encima de su ficha.
//   hoja normal (… | 41) → cebolla (blanco | 42) → cebolla (44 | blanco) → hoja normal (43 | 45) …
for (let P = 41; P <= 81; P += 4) {
  add('onion', BLANK, fromFolio(P + 1));
  add('onion', fromFolio(P + 3), BLANK);
  add('paper', fromFolio(P + 2), fromFolio(P + 4));
}
for (let pdf = 45; pdf <= 49; pdf++) add('paper', fromPdf(pdf, 'R'), fromPdf(pdf + 1, 'L'));
add('paper', fromPdf(50, 'R'), BLANK);
add('cover', BLANK, BLANK);

const N = leaves.length;
leaves.forEach(l => {
  l.t = THICK[l.kind];
  l.p = 0;            // 0 = en la derecha, 1 = pasada a la izquierda
  l.anim = null;
  l.drag = false;
  l.lift = 0;         // pequeño levantamiento al pasar el ratón
});
// altura de cada hoja dentro de su montón (derecha / izquierda)
for (let i = N - 1, z = 0; i >= 0; i--) { leaves[i].hR = z + leaves[i].t / 2; z += leaves[i].t; }
for (let i = 0, z = 0; i < N; i++) { leaves[i].hL = z + leaves[i].t / 2; z += leaves[i].t; }

let cur = 0;          // hojas pasadas

// ---------------------------------------------------------------------
//  Escena
// ---------------------------------------------------------------------
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(TABLE);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), .04).texture;
scene.environmentIntensity = .36;   // luz de relleno: deja las sombras con cuerpo

const camera = new THREE.PerspectiveCamera(22, 1, 20, 6000);

// luz principal desde la izquierda y algo alta, como una ventana sobre una mesa blanca
const SUN_OFFSET = new THREE.Vector3(-640, 400, -180);   // ~30° sobre la mesa: sombras largas
const sun = new THREE.DirectionalLight('#fffaf1', 1.5);
sun.position.copy(SUN_OFFSET);
sun.castShadow = true;
sun.shadow.mapSize.set(3072, 3072);
Object.assign(sun.shadow.camera, { left: -230, right: 230, top: 230, bottom: -230, near: 400, far: 1400 });
sun.shadow.radius = 2.5;
sun.shadow.bias = -.00015;
sun.shadow.normalBias = .15;
scene.add(sun, sun.target);

const table = new THREE.Mesh(
  new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: '#ebeae6', roughness: .95 }),
);
table.receiveShadow = true;
scene.add(table);

const book = new THREE.Group();
scene.add(book);

// ---------------------------------------------------------------------
//  Material de página: tinta (PNG con alfa) sobre papel, con el reverso
//  trasluciendo en espejo. El papel cebolla es además semitransparente.
// ---------------------------------------------------------------------
function pageMaterial(kind, back) {
  const m = new THREE.MeshStandardMaterial({
    roughness: kind === 'cover' ? .82 : .9,
    metalness: 0,
    side: back ? THREE.BackSide : THREE.FrontSide,
    transparent: kind === 'onion',
  });
  m.defines = { USE_UV: '' };
  const u = m.userData.u = {
    uInk: { value: null }, uOther: { value: null },
    uHasInk: { value: 0 }, uHasOther: { value: 0 },
    uPaper: { value: new THREE.Color(PAPER[kind]) },
    uAlpha: { value: ALPHA[kind] },
    uThrough: { value: THROUGH[kind] },
    uFlip: { value: back ? 1 : 0 },
  };
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uInk, uOther;
        uniform float uHasInk, uHasOther, uAlpha, uThrough, uFlip;
        uniform vec3 uPaper;
        float grain(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`)
      .replace('#include <map_fragment>', `
        vec2 uvF = vec2(uFlip > .5 ? 1. - vUv.x : vUv.x, vUv.y);
        float s = vUv.x;                                  // 0 en el lomo, 1 en el borde exterior
        vec4 ink = uHasInk > .5 ? texture2D(uInk, uvF) : vec4(0.);
        vec4 oth = uHasOther > .5 ? texture2D(uOther, vec2(1. - uvF.x, uvF.y)) : vec4(0.);
        vec3 col = uPaper * (1. - .018 * grain(floor(vUv * vec2(900., 1280.))));
        col = mix(col, col * mix(vec3(1.), oth.rgb, .85), oth.a * uThrough);
        float ia = 1. - pow(1. - ink.a, 1.6);             // la tinta fina no se pierde al reducir
        col = mix(col, ink.rgb * .92, ia);
        float a = mix(uAlpha, 1., ia * .93);
        col *= 1. - .16 * exp(-s * 38.);                 // sombra en el pliegue del lomo
        diffuseColor.rgb *= col;
        diffuseColor.a *= a;`);
  };
  return m;
}

// ---------------------------------------------------------------------
//  Geometría de cada hoja: una tira deformable a lo largo del ancho
// ---------------------------------------------------------------------
const NS = SEG + 1, ds = W / SEG;

function leafGeometry() {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(NS * 2 * 3), nor = new Float32Array(NS * 2 * 3), uv = new Float32Array(NS * 2 * 2);
  for (let k = 0; k < NS; k++) {
    uv.set([k / SEG, 1], k * 2);
    uv.set([k / SEG, 0], (NS + k) * 2);
  }
  const idx = [];
  for (let k = 0; k < SEG; k++) {
    const a0 = k, a1 = k + 1, b0 = NS + k, b1 = NS + k + 1;
    idx.push(b0, b1, a1, b0, a1, a0);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

leaves.forEach((l, i) => {
  l.geo = leafGeometry();
  l.matF = pageMaterial(l.kind, false);
  l.matB = pageMaterial(l.kind, true);
  l.meshF = new THREE.Mesh(l.geo, l.matF);
  l.meshB = new THREE.Mesh(l.geo, l.matB);
  for (const m of [l.meshF, l.meshB]) {
    m.castShadow = m.receiveShadow = true;
    m.frustumCulled = false;
    m.userData.leaf = i;
    book.add(m);
  }
  l.px = new Float32Array(NS);
  l.py = new Float32Array(NS);
  l.th = new Float32Array(NS);
});

// ---------------------------------------------------------------------
//  Forma del papel. La hoja es inextensible: se define el ángulo a lo
//  largo de su ancho y se integra. Al pasarla, el borde exterior se
//  adelanta y la hoja se curva.
//
//  Libro de lomo encolado abierto: el lomo queda apoyado en la mesa y cada
//  mitad (tapa + bloque) sale casi vertical de él, dobla en «U» y hace un
//  arco que se separa de la mesa antes de volver a tocarla en el borde.
//  Primero se calcula esa curva para la tapa; cada hoja va paralela por
//  encima, a la altura que ocupa en su bloque.
// ---------------------------------------------------------------------
const smooth = t => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
const ARCH = 9;                  // altura de la joroba junto al lomo (mm)
const ARCH_PEAK = .14 * W;       // dónde está la parte más alta
const ARCH_FLAT = .6 * W;        // desde aquí la hoja ya está plana sobre la mesa
const BN = 360, BL = W * 1.08, dsb = BL / BN;
const bx = new Float64Array(BN + 1), by = new Float64Array(BN + 1), bth = new Float64Array(BN + 1);
const qx = new Float64Array(BN + 1), qy = new Float64Array(BN + 1);
const tmpR = new Float32Array(SEG), tmpL = new Float32Array(SEG);
let baseO = -1;

// curva de la tapa (mitad derecha), desde el canto del lomo en la mesa
function buildBase(o) {
  if (o === baseO) return;
  baseO = o;
  const SP = ARCH_PEAK, SE = ARCH_FLAT;
  // pendiente de la joroba: sube hasta SP y baja suavemente hasta SE; luego plano
  const slope = s => s < SP ? ARCH * Math.PI / (2 * SP) * Math.cos(Math.PI / 2 * s / SP)
    : s < SE ? -ARCH * .5 * Math.PI / (SE - SP) * Math.sin(Math.PI * (s - SP) / (SE - SP)) : 0;
  // la corrección solo actúa en la bajada, para que la parte plana quede sobre la mesa
  const fix = s => s > SP && s < SE ? Math.sin(Math.PI * (s - SP) / (SE - SP)) : 0;
  const ang = (s, c) => o * (.95 * Math.exp(-s / 3.6) + Math.atan(slope(s)) - c * fix(s));
  const endY = c => {
    let y = 0;
    for (let s = dsb / 2; s < W; s += dsb) y += Math.sin(ang(s, c)) * dsb;
    return y;
  };
  // inclina la curva lo justo para que el borde exterior vuelva a la mesa
  let lo = -1, hi = 1.5;
  for (let it = 0; it < 32; it++) { const mid = (lo + hi) / 2; if (endY(mid) > .05) lo = mid; else hi = mid; }
  const c = (lo + hi) / 2;
  let x = 0, y = 0;
  for (let k = 0; k <= BN; k++) {
    bth[k] = ang(k * dsb, c);
    bx[k] = x; by[k] = y;
    const a = ang((k + .5) * dsb, c);
    x += Math.cos(a) * dsb; y += Math.sin(a) * dsb;
  }
}

// forma en reposo (mitad derecha) de una hoja a altura h sobre la tapa;
// xs = canto del lomo. Devuelve el punto de arranque y deja los ángulos en out.
function restShape(h, o, xs, out) {
  buildBase(o);
  for (let k = 0; k <= BN; k++) {
    qx[k] = xs + bx[k] - h * Math.sin(bth[k]);
    qy[k] = by[k] + h * Math.cos(bth[k]);
  }
  let k = 0, px = qx[0], py = qy[0], segLeft = Math.hypot(qx[1] - qx[0], qy[1] - qy[0]);
  for (let j = 0; j < SEG; j++) {
    let need = ds, nx = px, ny = py;
    while (need > 1e-9) {
      if (k >= BN) {                      // fuera de la curva: sigue recto
        const a = Math.atan2(qy[BN] - qy[BN - 1], qx[BN] - qx[BN - 1]);
        nx += Math.cos(a) * need; ny += Math.sin(a) * need; need = 0; break;
      }
      const sx = qx[k + 1] - qx[k], sy = qy[k + 1] - qy[k], len = Math.hypot(sx, sy) || 1e-9;
      const take = Math.min(need, segLeft);
      nx += sx / len * take; ny += sy / len * take;
      need -= take; segLeft -= take;
      if (segLeft <= 1e-9) { k++; if (k < BN) segLeft = Math.hypot(qx[k + 1] - qx[k], qy[k + 1] - qy[k]); }
    }
    out[j] = Math.atan2(ny - py, nx - px);
    px = nx; py = ny;
  }
  return [qx[0], qy[0]];
}

// El bloque solo empieza a curvarse (joroba junto al lomo) cuando la tapa ya ha
// pasado de la vertical; antes atravesaría la tapa, que aún está junto al lomo.
// giro de la hoja junto al lomo (el borde exterior va por delante, el lomo detrás)
const spinePhase = p => .5 - .5 * Math.cos(Math.PI * smooth(p * (1 + LEAD) - LEAD));
const pastHalf = x => smooth((x - .5) / .5);
function openness() {
  return Math.min(pastHalf(spinePhase(leaves[0].p)), pastHalf(1 - spinePhase(leaves[N - 1].p)));
}
const effP = l => Math.min(1, Math.max(0, l.p + l.lift));

// grosor de cada bloque según la página abierta
const stackR = () => leaves.reduce((z, l, i) => i >= cur ? z + l.t : z, 0);
const stackL = () => leaves.reduce((z, l, i) => i < cur ? z + l.t : z, 0);

function shapeLeaf(l, o) {
  const p = effP(l);
  const [rx, ry] = restShape(l.hR, o, stackR() * o, tmpR);
  const [lx, ly] = restShape(l.hL, o, stackL() * o, tmpL);   // reflejada después
  const q = t => .5 - .5 * Math.cos(Math.PI * smooth(t));
  // el punto de encolado solo baja/cambia de lado cuando la hoja ya está en la
  // otra mitad; si bajase antes, la tapa atravesaría las hojas de debajo
  const e = pastHalf(spinePhase(p));
  let x = rx + (-lx - rx) * e, y = ry + (ly - ry) * e;
  l.px[0] = x; l.py[0] = y;
  for (let k = 0; k < SEG; k++) {
    const s = (k + .5) / SEG;
    const ph = q(p * (1 + LEAD) - LEAD * (1 - s));
    const tR = tmpR[k], tL = Math.PI - tmpL[k];
    const th = tR + (tL - tR) * ph;
    l.th[k] = th;
    x += Math.cos(th) * ds; y += Math.sin(th) * ds;
    l.px[k + 1] = x; l.py[k + 1] = Math.max(y, .02);
  }
  const pos = l.geo.attributes.position.array, nor = l.geo.attributes.normal.array;
  for (let k = 0; k < NS; k++) {
    const th = k === 0 ? l.th[0] : k === SEG ? l.th[SEG - 1] : (l.th[k - 1] + l.th[k]) / 2;
    const nx = -Math.sin(th), ny = Math.cos(th);
    pos.set([l.px[k], l.py[k], -H / 2], k * 3);
    pos.set([l.px[k], l.py[k], H / 2], (NS + k) * 3);
    nor.set([nx, ny, 0], k * 3);
    nor.set([nx, ny, 0], (NS + k) * 3);
  }
  l.geo.attributes.position.needsUpdate = true;
  l.geo.attributes.normal.needsUpdate = true;
}

// ---------------------------------------------------------------------
//  Cantos del bloque (cabeza, pie, corte delantero y lomo)
// ---------------------------------------------------------------------
const edgeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .95, side: THREE.DoubleSide });
const edgeMeshes = [new THREE.Mesh(new THREE.BufferGeometry(), edgeMat), new THREE.Mesh(new THREE.BufferGeometry(), edgeMat)];
edgeMeshes.forEach(m => { m.castShadow = m.receiveShadow = true; m.frustumCulled = false; book.add(m); });

// perfil de una hoja desplazado d mm hacia su cara delantera (para dibujar su grosor)
function shifted(l, d) {
  const px = new Float32Array(NS), py = new Float32Array(NS);
  for (let k = 0; k < NS; k++) {
    const th = k === 0 ? l.th[0] : k === SEG ? l.th[SEG - 1] : (l.th[k - 1] + l.th[k]) / 2;
    px[k] = l.px[k] - Math.sin(th) * d;
    py[k] = l.py[k] + Math.cos(th) * d;
  }
  return { px, py, kind: l.kind };
}

function buildEdges(mesh, stack, side) {
  // stack: hojas de abajo a arriba. Se añaden las caras exteriores de las dos
  // hojas de los extremos para que las tapas muestren todo su grosor.
  const pos = [], col = [];
  const c = new THREE.Color();
  const quad = (a, b, cc, d, color) => {
    pos.push(...a, ...b, ...cc, ...a, ...cc, ...d);
    for (let k = 0; k < 6; k++) col.push(color.r, color.g, color.b);
  };
  if (stack.length) {
    // en la derecha la cara delantera mira hacia arriba; en la izquierda, hacia abajo
    const s = side === 'R' ? 1 : -1, a = stack[0], b = stack[stack.length - 1];
    stack = [shifted(a, -s * a.t / 2), ...stack, shifted(b, s * b.t / 2)];
  }
  for (let j = 0; j + 1 < stack.length; j++) {
    const A = stack[j], B = stack[j + 1];
    const cover = A.kind === 'cover' || B.kind === 'cover';
    c.set(EDGE[cover ? 'cover' : B.kind]).multiplyScalar(cover || j % 2 ? 1 : .97);
    for (let k = 0; k < SEG; k++) {
      for (const z of [-H / 2, H / 2]) {
        quad([A.px[k], A.py[k], z], [A.px[k + 1], A.py[k + 1], z], [B.px[k + 1], B.py[k + 1], z], [B.px[k], B.py[k], z], c);
      }
    }
    for (const k of [0, SEG]) {
      quad([A.px[k], A.py[k], -H / 2], [A.px[k], A.py[k], H / 2], [B.px[k], B.py[k], H / 2], [B.px[k], B.py[k], -H / 2],
        k === 0 ? c.clone().set(EDGE.cover) : c);
    }
  }
  const g = mesh.geometry;
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  mesh.visible = stack.length > 1;
}

// ---------------------------------------------------------------------
//  Revelado: grano fotográfico muy sutil y un ligero viñeteado. El grano
//  solo cambia cuando cambia la imagen, así que con el cuaderno quieto se
//  ve como una fotografía.
// ---------------------------------------------------------------------
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType }));
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new OutputPass());
const photo = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uSeed: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) }, uGrain: { value: .022 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uSeed, uGrain; uniform vec2 uRes;
    varying vec2 vUv;
    float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031 + uSeed); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 px = floor(vUv * uRes / 1.25);
      float n = hash(px) + hash(px + 17.13) - 1.;          // ruido triangular, -1..1
      float l = dot(c.rgb, vec3(.299, .587, .114));
      c.rgb += n * uGrain * (.45 + 1.6 * l * (1. - l));      // más grano en los medios tonos
      vec2 d = vUv - .5;
      c.rgb *= 1. - .1 * dot(d, d) * 2.;                     // viñeteado leve
      gl_FragColor = c;
    }`,
});
composer.addPass(photo);

// ---------------------------------------------------------------------
//  Texturas (solo las hojas cercanas a la página abierta)
// ---------------------------------------------------------------------
const loader = new THREE.TextureLoader();
const texCache = new Map();
let texLoads = 0;
const maxAniso = renderer.capabilities.getMaxAnisotropy();

// a = resolución normal, h = alta (solo para la doble página abierta)
function texture(key) {
  let e = texCache.get(key);
  if (!e) {
    e = { tex: null, users: new Set() };
    texCache.set(key, e);
    const ready = t => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = maxAniso;
      e.tex = t;
      if (!texCache.has(key)) { t.dispose(); return; }
      e.users.forEach(fn => fn(t));
      texLoads++;
      dirty = true;
    };
    loader.load(`img/${key}.webp`, ready, undefined, () => {
      if (key.startsWith('h/')) loader.load(`img/a/${key.slice(2)}.webp`, ready);
    });
  }
  return e;
}

function bind(mat, uniform, has, key) {
  const u = mat.userData.u;
  if (!key) { u[has].value = 0; u[uniform].value = null; return; }
  const e = texture(key);
  const set = t => {
    const old = u[uniform].value;
    u[uniform].value = t; u[has].value = 1;
    if (old && old !== t && ![...texCache.values()].some(x => x.tex === old)) old.dispose();
  };
  e.users.add(set);
  if (e.tex) set(e.tex);
}

function syncTextures() {
  const want = new Set();
  leaves.forEach((l, i) => {
    const tier = i >= cur - 2 && i <= cur + 1 ? 'h' : i >= cur - 4 && i <= cur + 4 ? 'a' : null;
    const key = s => tier && s ? `${tier}/${s}` : null;
    if (tier) [l.front.src, l.back.src].forEach(s => s && want.add(key(s)));
    if (tier === l.tier) return;
    l.tier = tier;
    bind(l.matF, 'uInk', 'uHasInk', key(l.front.src));
    bind(l.matF, 'uOther', 'uHasOther', key(l.back.src));
    bind(l.matB, 'uInk', 'uHasInk', key(l.back.src));
    bind(l.matB, 'uOther', 'uHasOther', key(l.front.src));
  });
  const inUse = new Set();
  leaves.forEach(l => [l.matF, l.matB].forEach(m => { inUse.add(m.userData.u.uInk.value); inUse.add(m.userData.u.uOther.value); }));
  for (const [key, e] of texCache) {
    if (want.has(key)) continue;
    texCache.delete(key);
    if (e.tex && !inUse.has(e.tex)) e.tex.dispose();
  }
}

// ---------------------------------------------------------------------
//  Estado y animación
// ---------------------------------------------------------------------
let dirty = true, lastO = -1;

function inFlight(l) { return l.anim || l.drag || l.lift > 0 && l.lift < 1; }

function relayout(force) {
  const o = openness();
  if (relayout.cur !== cur) { force = true; relayout.cur = cur; }   // el pliegue se desplaza sobre el lomo
  const oChanged = Math.abs(o - lastO) > 1e-5;
  leaves.forEach(l => {
    if (force || oChanged || l.anim || l.drag || l.liftChanged) shapeLeaf(l, o);
    l.liftChanged = false;
  });
  // montones: hojas quietas a cada lado (de abajo a arriba)
  const right = [], left = [];
  for (let i = N - 1; i >= 0; i--) if (!leaves[i].anim && !leaves[i].drag && leaves[i].p === 0) right.push(leaves[i]);
  for (let i = 0; i < N; i++) if (!leaves[i].anim && !leaves[i].drag && leaves[i].p === 1) left.push(leaves[i]);
  const key = right.length + ':' + left.length;
  if (force || oChanged || key !== relayout.key || right.some(l => l.lift) || left.some(l => l.lift)) {
    buildEdges(edgeMeshes[0], right.filter(l => !l.lift), 'R');
    buildEdges(edgeMeshes[1], left.filter(l => !l.lift), 'L');
    relayout.key = key;
  }
  // orden de dibujado para que las capas de papel cebolla se mezclen bien
  right.forEach((l, j) => { l.meshF.renderOrder = l.meshB.renderOrder = j; });
  left.forEach((l, j) => { l.meshF.renderOrder = l.meshB.renderOrder = j; });
  leaves.forEach(l => { if (l.anim || l.drag || l.lift) l.meshF.renderOrder = l.meshB.renderOrder = 500 + (l.anim ? 1 : 0); });
  lastO = o;
}

function animate(i, to, ms = FLIP_MS, delay = 0) {
  const l = leaves[i];
  l.drag = false;
  l.anim = { from: l.p, to, t0: performance.now() + delay, dur: ms * Math.max(.3, Math.abs(to - l.p)) };
}

function step(now) {
  let moving = false;
  leaves.forEach(l => {
    if (!l.anim) return;
    const a = l.anim, t = Math.min(1, Math.max(0, (now - a.t0) / a.dur));
    l.p = a.from + (a.to - a.from) * t;
    if (t >= 1) { l.p = a.to; l.anim = null; }
    moving = true;
  });
  // levantamiento suave de la esquina al pasar el ratón
  leaves.forEach((l, i) => {
    const target = hover && hover.leaf === i && !l.anim && !l.drag ? hover.amount : 0;
    if (Math.abs(target - l.lift) > 1e-4) {
      l.lift += (target - l.lift) * .18;
      if (Math.abs(target - l.lift) < 1e-3) l.lift = target;
      l.liftChanged = true;
      moving = true;
    }
  });
  return moving;
}

// ---------------------------------------------------------------------
//  Cámara
// ---------------------------------------------------------------------
const VIEWS = { top: { polar: 7, azim: 0 }, iso: { polar: 54, azim: -34 } };
let view = 'top';
const cam = { polar: 7, azim: 0, dist: 1200, tx: W / 2, ty: 0 };
let zoom = 1, snapCam = false;
const pan = { x: 0, z: 0 };
const ZOOM_MAX = 4;

function cameraTarget() {
  const b = cameraBase();
  return { ...b, dist: b.dist / zoom, tx: b.tx + pan.x, ty: b.ty + pan.z };
}

function cameraBase() {
  const o = openness();
  const side = cur > N / 2 ? -1 : 1;
  const v = VIEWS[view];
  const fw = W * (1 + o) * 1.12, fh = H * 1.16;
  const aspect = innerWidth / innerHeight;
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const chrome = innerHeight / Math.max(200, innerHeight - (innerWidth < 600 ? 150 : 190));
  let dist = Math.max(fh / 2 / tanV, fw / 2 / (tanV * aspect)) * chrome;
  if (innerWidth >= 600) dist *= 1 + 130 / innerWidth;    // sitio para las flechas laterales
  if (view === 'iso') dist *= .98;
  return { polar: v.polar, azim: v.azim, dist, tx: side * W / 2 * (1 - o), ty: 0 };
}

function updateCamera(dt) {
  const t = cameraTarget();
  const k = snapCam ? 1 : 1 - Math.exp(-dt * (zooming > 0 ? 9 : 4.5));
  zooming = Math.max(0, zooming - dt);
  let moved = false;
  for (const key in t) {
    const d = t[key] - cam[key];
    if (Math.abs(d) > 1e-3) { cam[key] += d * k; moved = true; }
  }
  const P = THREE.MathUtils.degToRad(cam.polar), A = THREE.MathUtils.degToRad(cam.azim);
  const tgt = new THREE.Vector3(cam.tx, 0, cam.ty + H * .015);
  camera.position.set(tgt.x + cam.dist * Math.sin(P) * Math.sin(A), cam.dist * Math.cos(P), tgt.z + cam.dist * Math.sin(P) * Math.cos(A));
  camera.lookAt(tgt);
  sun.target.position.copy(tgt);
  sun.position.copy(tgt).add(SUN_OFFSET);
  return moved;
}

let zooming = 0;

function tableAt(cx, cy, cameraRef = camera) {
  ndc.set(cx / innerWidth * 2 - 1, -(cy / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, cameraRef);
  return ray.ray.intersectPlane(deskPlane, new THREE.Vector3());
}

function clampPan() {
  if (zoom <= 1.001) { zoom = 1; pan.x = pan.z = 0; }
  pan.x = Math.max(-W * 1.1, Math.min(W * 1.1, pan.x));
  pan.z = Math.max(-H * .6, Math.min(H * .6, pan.z));
}

// amplía manteniendo fijo el punto de la mesa que hay bajo (cx, cy)
function zoomAt(cx, cy, z) {
  z = Math.max(1, Math.min(ZOOM_MAX, z));
  const p = tableAt(cx, cy);
  if (p) {
    const b = cameraBase();
    const tx = b.tx + pan.x, tz = b.ty + pan.z;
    pan.x = p.x + (tx - p.x) * zoom / z - b.tx;
    pan.z = p.z + (tz - p.z) * zoom / z - b.ty;
  }
  zoom = z;
  zooming = .4;
  clampPan();
  updateZoomUI();
}
const zoomCenter = f => zoomAt(innerWidth / 2, innerHeight / 2, zoom * f);
function resetZoom() { zoom = 1; clampPan(); updateZoomUI(); }

function resize() {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  composer.setPixelRatio(Math.min(devicePixelRatio, 2));
  composer.setSize(innerWidth, innerHeight);
  renderer.getDrawingBufferSize(photo.uniforms.uRes.value);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  dirty = true;
}
addEventListener('resize', resize);

// ---------------------------------------------------------------------
//  Bucle
// ---------------------------------------------------------------------
let last = performance.now(), firstFrame = true;
function frame(now) {
  const dt = Math.min(.05, (now - last) / 1000);
  last = now;
  const moving = step(now);
  const camMoving = updateCamera(dt);
  if (moving || dirty) relayout(dirty && !moving);
  if (moving || camMoving || dirty) {
    photo.uniforms.uSeed.value = (photo.uniforms.uSeed.value + .6180339) % 1;
    composer.render();
    dirty = false;
    if (firstFrame && (texLoads > 1 || now > 2500)) { firstFrame = false; document.getElementById('loading').classList.add('gone'); }
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------
//  Navegación
// ---------------------------------------------------------------------
const $ = id => document.getElementById(id);
const ui = { prev: $('prev'), next: $('next'), pages: $('pages'),scrub: $('scrub'), tip: $('tip'), hint: $('hint') };

function next() {
  if (cur >= N) return;
  animate(cur, 1); cur++; changed();
}
function prev() {
  if (cur <= 0) return;
  cur--; animate(cur, 0); changed();
}
function go(to) {
  to = Math.max(0, Math.min(N, to));
  const d = to - cur;
  if (!d) return;
  if (Math.abs(d) <= 10) {
    // pasa las hojas seguidas, deprisa
    const n = Math.abs(d), ms = 820;
    for (let k = 0; k < n; k++) {
      const i = d > 0 ? cur + k : cur - 1 - k;
      animate(i, d > 0 ? 1 : 0, ms, k * 95);
    }
    cur = to;
  } else {
    cur = to;
    leaves.forEach((l, i) => { l.anim = null; l.drag = false; l.p = i < cur ? 1 : 0; });
    dirty = true;
  }
  gesture = null;
  changed();
}

// número visible a cada lado: si la cara de arriba es cebolla en blanco, se mira la de debajo
function visibleFolio(side) {
  if (side === 'L') {
    for (let i = cur - 1; i >= 0; i--) { const f = leaves[i].back; if (f.num) return f.num; if (leaves[i].kind !== 'onion') return null; }
  } else {
    for (let i = cur; i < N; i++) { const f = leaves[i].front; if (f.num) return f.num; if (leaves[i].kind !== 'onion') return null; }
  }
  return null;
}
function spreadLabel(c) {
  const keep = cur; cur = c;
  let s;
  if (c === 0) s = 'Portada';
  else if (c === N) s = 'Contraportada';
  else {
    const L = visibleFolio('L'), R = visibleFolio('R');
    s = L && R ? `${L} — ${R}` : L || R ? `${L || R}` : c === 1 ? 'Portadilla' : 'Anexo';
  }
  cur = keep;
  return s;
}

function changed() {
  syncTextures();
  ui.prev.disabled = cur === 0;
  ui.next.disabled = cur === N;
  ui.scrub.value = cur;
  ui.scrub.style.setProperty('--fill', (cur / N * 100) + '%');
  ui.pages.textContent = spreadLabel(cur);
  if (cur > 0) ui.hint.classList.add('gone');
  history.replaceState(null, '', cur ? `?hoja=${cur}` : location.pathname);
  dirty = true;
}

ui.next.addEventListener('click', next);
ui.prev.addEventListener('click', prev);
ui.scrub.max = N;
const showTip = () => {
  const v = +ui.scrub.value;
  ui.tip.textContent = spreadLabel(v);
  ui.tip.style.left = (v / N * 100) + '%';
  ui.tip.classList.add('on');
};
ui.scrub.addEventListener('input', showTip);
ui.scrub.addEventListener('change', () => { ui.tip.classList.remove('on'); go(+ui.scrub.value); });
ui.scrub.addEventListener('pointerup', () => ui.tip.classList.remove('on'));

document.querySelectorAll('.views button').forEach(b => b.addEventListener('click', () => {
  view = b.dataset.view;
  document.querySelectorAll('.views button').forEach(x => x.setAttribute('aria-pressed', x === b));
}));

addEventListener('keydown', e => {
  if (e.target === ui.scrub) return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { next(); e.preventDefault(); }
  else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { prev(); e.preventDefault(); }
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(N);
  else if (e.key === '+' || e.key === '=') zoomCenter(1.4);
  else if (e.key === '-') zoomCenter(1 / 1.4);
  else if (e.key === '0' || e.key === 'Escape') resetZoom();
});

const zoomUI = { in: $('zoomIn'), out: $('zoomOut'), reset: $('zoomReset') };
zoomUI.in.addEventListener('click', () => zoomCenter(1.5));
zoomUI.out.addEventListener('click', () => zoomCenter(1 / 1.5));
zoomUI.reset.addEventListener('click', resetZoom);
function updateZoomUI() {
  zoomUI.out.disabled = zoom <= 1.001;
  zoomUI.in.disabled = zoom >= ZOOM_MAX - .001;
  zoomUI.reset.hidden = zoom <= 1.001;
  canvas.classList.toggle('zoomed', zoom > 1.001);
}

// ---------------------------------------------------------------------
//  Ratón y tacto: pulsar o arrastrar la página; al acercarse al borde
//  la esquina se levanta un poco para indicar que se puede pasar.
// ---------------------------------------------------------------------
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), hit = new THREE.Vector3();
const deskPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -2);
let gesture = null, hover = null;

function pointOnBook(e) {
  ndc.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (!ray.ray.intersectPlane(deskPlane, hit)) return null;
  const o = openness();
  const minX = cur === 0 ? 0 : -W * Math.max(o, cur === N ? 1 : 0);
  const maxX = cur === N ? 0 : W;
  if (Math.abs(hit.z) > H / 2 + 4 || hit.x < minX - 4 || hit.x > maxX + 4) return null;
  return { x: hit.x, side: cur === 0 ? 'R' : cur === N ? 'L' : hit.x >= 0 ? 'R' : 'L' };
}

function setHover(pt) {
  let h = null;
  if (pt && !gesture) {
    const i = pt.side === 'R' ? cur : cur - 1;
    const busy = leaves.some(l => l.anim);
    if (i >= 0 && i < N && !busy) {
      const edge = Math.abs(pt.x) / W;            // 0 en el lomo, 1 en el borde
      const amt = .012 + .03 * smooth((edge - .45) / .5);
      h = { leaf: i, amount: pt.side === 'R' ? amt : -amt };
    }
  }
  hover = h;
  canvas.classList.toggle('hand', !!pt);
}

const touches = new Map();
let pinch = null;

canvas.addEventListener('pointerdown', e => {
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  canvas.setPointerCapture(e.pointerId);
  if (touches.size === 2) {
    // dos dedos: ampliar / reducir
    if (gesture && gesture.leaf >= 0 && leaves[gesture.leaf].drag) animate(gesture.leaf, leaves[gesture.leaf].p > .5 ? 1 : 0);
    gesture = null;
    const [a, b] = [...touches.values()];
    pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), z0: zoom };
    return;
  }
  const pt = pointOnBook(e);
  const panning = zoom > 1.001;
  if (!pt && !panning) return;
  gesture = {
    id: e.pointerId, x0: pt ? pt.x : 0, sx: e.clientX, sy: e.clientY, side: pt ? pt.side : null,
    moved: false, leaf: -1, onBook: !!pt, pan: panning ? { cam: camera.clone(), hit: tableAt(e.clientX, e.clientY), x: pan.x, z: pan.z } : null,
  };
});

canvas.addEventListener('pointermove', e => {
  if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && touches.size === 2) {
    const [a, b] = [...touches.values()];
    zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch.z0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0);
    return;
  }
  const pt = pointOnBook(e);
  if (!gesture) { setHover(zoom > 1.001 ? null : pt); canvas.classList.toggle('hand', !!pt); return; }
  if (e.pointerId !== gesture.id) return;
  if (gesture.pan) {
    // ampliado: arrastrar desplaza la vista
    if (!gesture.moved && Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > 4) { gesture.moved = true; snapCam = true; canvas.classList.add('grab'); }
    if (!gesture.moved || !gesture.pan.hit) return;
    const h = tableAt(e.clientX, e.clientY, gesture.pan.cam);
    if (!h) return;
    pan.x = gesture.pan.x - (h.x - gesture.pan.hit.x);
    pan.z = gesture.pan.z - (h.z - gesture.pan.hit.z);
    clampPan();
    return;
  }
  if (!gesture.moved && Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) > 6) {
    gesture.moved = true;
    const i = gesture.side === 'R' ? cur : cur - 1;
    if (i >= 0 && i < N && !leaves[i].anim) {
      gesture.leaf = i;
      gesture.p0 = leaves[i].p;
      leaves[i].drag = true;
      leaves[i].lift = 0;
      hover = null;
      canvas.classList.add('grab');
    }
  }
  if (gesture.leaf < 0 || !leaves[gesture.leaf].drag) return;
  ndc.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (!ray.ray.intersectPlane(deskPlane, hit)) return;
  // la mano lleva el borde de la hoja: x = W·cos(π·p)
  const l = leaves[gesture.leaf];
  const target = Math.acos(Math.max(-1, Math.min(1, hit.x / W))) / Math.PI;
  const start = Math.acos(Math.max(-1, Math.min(1, gesture.x0 / W))) / Math.PI;
  l.p = Math.max(0, Math.min(1, gesture.p0 + (target - start)));
  dirty = true;
});

function endGesture(e) {
  touches.delete(e.pointerId);
  if (touches.size < 2) pinch = null;
  if (!gesture || e.pointerId !== gesture.id) return;
  const g = gesture;
  gesture = null;
  snapCam = false;
  canvas.classList.remove('grab');
  if (!g.moved) {
    if (!g.onBook) return;
    if (g.side === 'R') next(); else prev();
    return;
  }
  if (g.leaf >= 0 && leaves[g.leaf].drag) {
    const i = g.leaf, l = leaves[i];
    if (g.side === 'R') {
      if (l.p > .25) { animate(i, 1); cur = i + 1; } else animate(i, 0);
    } else if (l.p < .75) { animate(i, 0); cur = i; } else animate(i, 1);
    changed();
  }
}
canvas.addEventListener('pointerup', endGesture);
canvas.addEventListener('pointercancel', endGesture);
canvas.addEventListener('pointerleave', () => { if (!gesture) setHover(null); });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, zoom * Math.exp(-e.deltaY * (e.ctrlKey ? .012 : .0018)));
}, { passive: false });

// ---------------------------------------------------------------------
//  Arranque
// ---------------------------------------------------------------------
resize();
const start = parseInt(new URLSearchParams(location.search).get('hoja'), 10);
if (start > 0) {
  cur = Math.min(N, start);
  leaves.forEach((l, i) => { l.p = i < cur ? 1 : 0; });
}
changed();
updateZoomUI();
relayout(true);
Object.assign(cam, cameraTarget());
updateCamera(0);
requestAnimationFrame(frame);

window.cuaderno = { go, next, prev, leaves, camera, zoomAt, resetZoom, get cur() { return cur; }, setView: v => { view = v; } };
