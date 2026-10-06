"use strict";
const $ = (id) => document.getElementById(id);
const PREFIX = "shareanywhere-";
const CHUNK = 64 * 1024;
const CODE_LIFETIME_MS = 10 * 60 * 1000;

// ---------- small helpers ----------
function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}
function li(list, name, size) {
  const el = document.createElement("li");
  el.innerHTML = "<span></span><span class='muted'></span>";
  el.children[0].textContent = name;
  el.children[1].textContent = size;
  list.appendChild(el);
  return el;
}
function randomCode() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 1000000).padStart(6, "0");
}

// ---------- device name ----------
const nameInput = $("devName");
nameInput.value = localStorage.getItem("sa-name") || "My Device";
nameInput.addEventListener("input", () => localStorage.setItem("sa-name", nameInput.value));
const myName = () => nameInput.value.trim() || "My Device";

// ---------- tabs ----------
function showTab(send) {
  $("tabSend").classList.toggle("active", send);
  $("tabRecv").classList.toggle("active", !send);
  $("sendPane").hidden = !send;
  $("recvPane").hidden = send;
  if (send) stopScanner();
}
$("tabSend").onclick = () => showTab(true);
$("tabRecv").onclick = () => showTab(false);

// =====================================================
//  SEND
// =====================================================
let files = [];
let sendPeer = null;
let expireTimer = null;

const drop = $("drop"), fileInput = $("fileInput");
drop.onclick = () => fileInput.click();
fileInput.onchange = () => addFiles(fileInput.files);
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); };

function addFiles(list) {
  files = files.concat(Array.from(list));
  $("fileList").innerHTML = "";
  files.forEach((f) => li($("fileList"), f.name, fmtSize(f.size)));
  $("btnStart").disabled = files.length === 0;
}

$("btnStart").onclick = () => startSending();
$("btnCancelSend").onclick = () => resetSend();

function resetSend() {
  clearTimeout(expireTimer);
  if (sendPeer) { sendPeer.destroy(); sendPeer = null; }
  files = [];
  fileInput.value = "";
  $("fileList").innerHTML = "";
  $("btnStart").disabled = true;
  $("sendBarWrap").hidden = true;
  $("sendBar").style.width = "0";
  $("sendStatus").className = "status";
  $("sendShare").hidden = true;
  $("sendPick").hidden = false;
}

function startSending(attempt = 0) {
  const code = randomCode();
  const peer = new Peer(PREFIX + code);
  sendPeer = peer;
  peer.on("error", (err) => {
    if (err.type === "unavailable-id" && attempt < 5) { peer.destroy(); startSending(attempt + 1); return; }
    $("sendStatus").textContent = "Connection problem: " + err.type;
    $("sendStatus").className = "status error";
  });
  peer.on("open", () => {
    $("sendPick").hidden = true;
    $("sendShare").hidden = false;
    $("codeText").textContent = code;
    $("sendStatus").textContent = "Waiting for the other device…";
    $("sendStatus").className = "status";
    const link = location.href.split("#")[0] + "#" + code;
    $("qr").innerHTML = "";
    new QRCode($("qr"), { text: link, width: 180, height: 180 });
    expireTimer = setTimeout(() => {
      if (sendPeer === peer && !peer.__used) { resetSend(); alert("Code expired. Make a new one."); }
    }, CODE_LIFETIME_MS);
  });
  peer.on("connection", (conn) => {
    if (peer.__used) { conn.close(); return; }   // one use only
    peer.__used = true;
    handleReceiver(conn);
  });
}

function handleReceiver(conn) {
  $("sendStatus").textContent = "Connected. Waiting for them to accept…";
  conn.on("open", () => {
    conn.send({ type: "offer", from: myName(), files: files.map((f) => ({ name: f.name, size: f.size })) });
  });
  conn.on("data", async (msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === "decline") {
      $("sendStatus").textContent = "The other device declined.";
      $("sendStatus").className = "status error";
    } else if (msg.type === "accept") {
      await sendAll(conn);
    }
  });
  conn.on("close", () => {
    if (!$("sendBar").dataset.done) {
      $("sendStatus").textContent = $("sendStatus").textContent.startsWith("Sent")
        ? $("sendStatus").textContent : "Connection closed.";
    }
  });
}

async function sendAll(conn) {
  const total = files.reduce((s, f) => s + f.size, 0);
  let sent = 0;
  $("sendBarWrap").hidden = false;
  try {
    for (const f of files) {
      conn.send({ type: "file-start", name: f.name, size: f.size });
      for (let off = 0; off < f.size; off += CHUNK) {
        const buf = await f.slice(off, off + CHUNK).arrayBuffer();
        // don't flood the connection: wait while its buffer is full
        while (conn.dataChannel && conn.dataChannel.bufferedAmount > 4 * 1024 * 1024) {
          await new Promise((r) => setTimeout(r, 30));
        }
        conn.send(buf);
        sent += buf.byteLength;
        $("sendBar").style.width = ((sent / total) * 100).toFixed(1) + "%";
        $("sendStatus").textContent = "Sending… " + fmtSize(sent) + " / " + fmtSize(total);
      }
      conn.send({ type: "file-end" });
    }
    conn.send({ type: "all-done" });
    $("sendBar").dataset.done = "1";
    $("sendStatus").textContent = "Sent! ✔";
    $("btnCancelSend").textContent = "Send more";
    $("btnCancelSend").onclick = () => { delete $("sendBar").dataset.done; $("btnCancelSend").textContent = "Cancel"; $("btnCancelSend").onclick = () => resetSend(); resetSend(); };
  } catch (e) {
    $("sendStatus").textContent = "Sending failed: " + e.message;
    $("sendStatus").className = "status error";
  }
}

// =====================================================
//  RECEIVE
// =====================================================
let recvPeer = null;
let scanner = null;

function stopScanner() {
  if (scanner) { scanner.stop().catch(() => {}).finally(() => { scanner.clear(); scanner = null; }); }
}

$("btnScan").onclick = async () => {
  if (scanner) { stopScanner(); return; }
  scanner = new Html5Qrcode("reader");
  try {
    await scanner.start(
      { facingMode: "environment" }, { fps: 10, qrbox: 220 },
      (text) => {
        const m = text.match(/(\d{6})\s*$/);
        if (m) { stopScanner(); $("codeInput").value = m[1]; connectWithCode(m[1]); }
      }
    );
  } catch (e) {
    scanner = null;
    alert("Can't open the camera. Type the code instead.");
  }
};

$("btnConnect").onclick = () => {
  const code = $("codeInput").value.trim();
  if (!/^\d{6}$/.test(code)) { alert("Please type the 6 digits."); return; }
  connectWithCode(code);
};

$("btnRecvDone").onclick = () => resetRecv();
function resetRecv() {
  if (recvPeer) { recvPeer.destroy(); recvPeer = null; }
  $("recvLive").hidden = true;
  $("recvEnter").hidden = false;
  $("codeInput").value = "";
  $("offerList").innerHTML = "";
  $("doneList").innerHTML = "";
  $("offerButtons").hidden = true;
  $("recvBarWrap").hidden = true;
  $("recvBar").style.width = "0";
  $("btnRecvDone").hidden = true;
  $("recvStatus").className = "status";
}

function recvFail(text) {
  $("recvStatus").textContent = text;
  $("recvStatus").className = "status error";
  $("btnRecvDone").hidden = false;
}

function connectWithCode(code) {
  stopScanner();
  $("recvEnter").hidden = true;
  $("recvLive").hidden = false;
  $("recvStatus").textContent = "Connecting…";
  $("recvStatus").className = "status";
  const peer = new Peer();
  recvPeer = peer;
  peer.on("error", (err) => {
    recvFail(err.type === "peer-unavailable" ? "Code not found or expired." : "Connection problem: " + err.type);
  });
  peer.on("open", () => {
    const conn = peer.connect(PREFIX + code, { reliable: true });
    setupReceiver(conn);
  });
}

function setupReceiver(conn) {
  let total = 0, got = 0;
  let cur = null;          // file being received {name,size,parts}
  const finished = [];

  conn.on("data", (msg) => {
    if (msg instanceof ArrayBuffer || ArrayBuffer.isView(msg)) {
      if (!cur) return;
      cur.parts.push(msg);
      got += msg.byteLength;
      $("recvBar").style.width = ((got / total) * 100).toFixed(1) + "%";
      $("recvStatus").textContent = "Receiving… " + fmtSize(got) + " / " + fmtSize(total);
      return;
    }
    if (msg.type === "offer") {
      total = msg.files.reduce((s, f) => s + f.size, 0);
      $("recvStatus").textContent = msg.from + " wants to send you " + msg.files.length + " file(s)";
      msg.files.forEach((f) => li($("offerList"), f.name, fmtSize(f.size)));
      $("offerButtons").hidden = false;
      $("btnAccept").onclick = () => {
        $("offerButtons").hidden = true;
        $("recvBarWrap").hidden = false;
        conn.send({ type: "accept" });
      };
      $("btnDecline").onclick = () => { conn.send({ type: "decline" }); resetRecv(); };
    } else if (msg.type === "file-start") {
      cur = { name: msg.name, size: msg.size, parts: [] };
    } else if (msg.type === "file-end") {
      const blob = new Blob(cur.parts);
      const url = URL.createObjectURL(blob);
      const item = li($("doneList"), cur.name, fmtSize(cur.size));
      const a = document.createElement("a");
      a.href = url; a.download = cur.name; a.textContent = "Save";
      item.children[1].textContent = "";
      item.children[1].appendChild(a);
      a.click();               // save automatically; link stays in case the browser blocks it
      cur = null;
    } else if (msg.type === "all-done") {
      $("recvStatus").textContent = "Done! ✔ Files received.";
      $("offerList").innerHTML = "";
      $("btnRecvDone").hidden = false;
    }
  });
  conn.on("close", () => {
    if ($("btnRecvDone").hidden) recvFail("The sender closed the connection.");
  });
}

// ---------- link with code (from QR) ----------
const hashCode = location.hash.replace("#", "");
if (/^\d{6}$/.test(hashCode)) {
  showTab(false);
  $("codeInput").value = hashCode;
}
