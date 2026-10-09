// yolo.js — runs the merged model threat_detector.onnx (built by build_combined.py).
//
//   input  "images"      float32 [1,3,640,640], RGB 0..1
//   output "weapon_out"  [1, 8, 8400]   (4 box values + 4 classes)
//   output "human_out"   [1, 84, 8400]  (COCO, 4 box values + 80 classes; only class 0 'person' is kept)
//
// Boxes are (cx,cy,w,h) in 640px space, class scores are already 0..1.
//
// Requires onnxruntime-web:
//   <script src="https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js"></script>

const INPUT_SIZE = 640;
const NUM_ANCHORS = 8400;
const IOU_THRESHOLD = 0.45;

const MODEL_URL = 'threat_detector.onnx';

// One entry per model output. `rows` is the expected size of the output's 2nd dimension;
// `classes` lists the class IDs to keep, each with its own display label and confidence threshold.
const HEADS = [
  {
    output: 'weapon_out',
    rows: 8,
    color: '#ff3b30',
    classes: [
      { id: 0, label: 'Gun',       conf: 0.5 },
      { id: 1, label: 'Explosion', conf: 0.5 },   // metadata name is 'explosion'
      { id: 2, label: 'Grenade',   conf: 0.5 },
      { id: 3, label: 'Knife',     conf: 0.5 },
    ],
  },
  {
    output: 'human_out',
    rows: 84,
    color: '#34c759',
    classes: [
      { id: 0, label: 'Human', conf: 0.4 },        // COCO 'person', renamed
    ],
  },
];

let session = null;

async function loadModel(url = MODEL_URL) {
  session = await ort.InferenceSession.create(url, { executionProviders: ['wasm'] });
  return session;
}

// Resize with aspect ratio preserved, pad to 640x640 with gray (114), return CHW float tensor.
function preprocess(source) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;

  const scale = Math.min(INPUT_SIZE / sw, INPUT_SIZE / sh);
  const nw = Math.round(sw * scale);
  const nh = Math.round(sh * scale);
  const padX = Math.floor((INPUT_SIZE - nw) / 2);
  const padY = Math.floor((INPUT_SIZE - nh) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = INPUT_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  ctx.drawImage(source, padX, padY, nw, nh);

  const { data } = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE); // RGBA
  const plane = INPUT_SIZE * INPUT_SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = data[i * 4] / 255;
    input[plane + i] = data[i * 4 + 1] / 255;
    input[2 * plane + i] = data[i * 4 + 2] / 255;
  }

  return {
    tensor: new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]),
    scale, padX, padY, sw, sh,
  };
}

// Decode one model's raw output into boxes in ORIGINAL image coordinates.
function decode(output, meta, model) {
  if (output.dims[1] !== model.rows || output.dims[2] !== NUM_ANCHORS) {
    throw new Error(`${model.output}: expected output [1,${model.rows},${NUM_ANCHORS}], got [${output.dims.join(',')}]`);
  }
  const data = output.data;
  const boxes = [];

  for (let i = 0; i < NUM_ANCHORS; i++) {
    let best = null, bestScore = 0;
    for (const c of model.classes) {
      const s = data[(4 + c.id) * NUM_ANCHORS + i];
      if (s >= c.conf && s > bestScore) { bestScore = s; best = c; }
    }
    if (!best) continue;

    const cx = data[i];
    const cy = data[NUM_ANCHORS + i];
    const w  = data[2 * NUM_ANCHORS + i];
    const h  = data[3 * NUM_ANCHORS + i];

    boxes.push({
      x1: Math.max(0, (cx - w / 2 - meta.padX) / meta.scale),
      y1: Math.max(0, (cy - h / 2 - meta.padY) / meta.scale),
      x2: Math.min(meta.sw, (cx + w / 2 - meta.padX) / meta.scale),
      y2: Math.min(meta.sh, (cy + h / 2 - meta.padY) / meta.scale),
      score: bestScore,
      label: best.label,
      color: model.color,
    });
  }
  return nms(boxes, IOU_THRESHOLD);
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union <= 0 ? 0 : inter / union;
}

// Per-label non-max suppression.
function nms(boxes, iouThreshold) {
  boxes.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const box of boxes) {
    if (!kept.some(k => k.label === box.label && iou(k, box) > iouThreshold)) kept.push(box);
  }
  return kept;
}

// Full pipeline: image/video/canvas element -> detections from all heads.
async function detect(source) {
  if (!session) await loadModel();
  const meta = preprocess(source);
  const results = await session.run({ images: meta.tensor });
  const all = [];
  for (const head of HEADS) all.push(...decode(results[head.output], meta, head));
  return all;
}

// Draw detections on a canvas that is the same size as the source.
function drawDetections(ctx, detections) {
  ctx.lineWidth = 3;
  ctx.font = '16px sans-serif';
  ctx.textBaseline = 'top';
  for (const d of detections) {
    const text = `${d.label} ${(d.score * 100).toFixed(0)}%`;
    const tw = ctx.measureText(text).width + 8;
    ctx.strokeStyle = ctx.fillStyle = d.color;
    ctx.strokeRect(d.x1, d.y1, d.x2 - d.x1, d.y2 - d.y1);
    ctx.fillRect(d.x1, Math.max(0, d.y1 - 22), tw, 22);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, d.x1 + 4, Math.max(0, d.y1 - 20));
  }
}
