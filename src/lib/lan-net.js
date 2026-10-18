'use strict';

// LAN 共有サーバの「どこに立てて、誰を通すか」だけを切り出したもの。
// 判定を間違えると所持作品がそのまま外へ出るので、サーバ本体とは別に置いて単体で検める

const os = require('os');

// プライベート帯かどうか。ここを緩めると、ルータの穴あけ事故のときに歯止めが無くなる
function isPrivateAddress(raw) {
  let address = String(raw || '').trim();
  if (!address) return false;
  // IPv4 射影 (::ffff:192.168.1.5) で来ることがある。剥がしてから見る
  if (address.toLowerCase().startsWith('::ffff:')) address = address.slice(7);
  // 帯記号 (fe80::1%eth0) は判定に要らない
  const zone = address.indexOf('%');
  if (zone >= 0) address = address.slice(0, zone);

  const v4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((n) => n > 255)) return false;
    const [a, b] = octets;
    if (a === 127) return true;                      // 自分自身
    if (a === 10) return true;                       // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true;          // 192.168/16
    if (a === 169 && b === 254) return true;          // リンクローカル
    // 100.64/10 (CGNAT 帯) = Tailscale が端末に配る帯。tailnet の中は
    // 鍵交換済みの自分の端末だけなので、私的な帯として通す。
    // 公衆網でこの帯が発信元として届くことは無い (経路が無い)
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  const lower = address.toLowerCase();
  if (lower === '::1') return true;          // 自分自身
  if (lower.startsWith('fe80:')) return true; // リンクローカル
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // ユニークローカル fc00::/7
  return false;
}

function isTailscaleAddress(raw) {
  const v4 = String(raw || '').match(/^(\d{1,3})\.(\d{1,3})\./);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return a === 100 && b >= 64 && b <= 127;
}

// 立てられる宛先 (内部でない IPv4 のプライベートアドレス)。
// 0.0.0.0 では立てない: 公衆側の口まで開く道を、そもそも選択肢から外す。
// Tailscale の口 (100.64/10) は家の LAN と分けて返す — 立てる側が別々に扱う
function collectAddresses() {
  const lan = [];
  const tailscale = [];
  const nics = os.networkInterfaces();
  for (const [name, list] of Object.entries(nics || {})) {
    for (const nic of list || []) {
      if (!nic || nic.internal) continue;
      // Node 18 以降は family が 'IPv4'、それ以前は 4 のことがある
      if (nic.family !== 'IPv4' && nic.family !== 4) continue;
      if (!isPrivateAddress(nic.address)) continue;
      if (isTailscaleAddress(nic.address)) tailscale.push({ name, address: nic.address });
      else lan.push({ name, address: nic.address });
    }
  }
  return { lan, tailscale };
}

function lanAddresses() {
  return collectAddresses().lan;
}

function tailscaleAddresses() {
  return collectAddresses().tailscale;
}

// Host ヘッダが自分の宛先と一致するか。
// 見ないと DNS rebinding が通る: 外のページが利用者のブラウザ越しにこのサーバを叩ける。
// address は一つでも複数 (LAN + Tailscale) でも受ける
function hostAllowed(header, address, port) {
  const raw = String(header || '').trim().toLowerCase();
  if (!raw) return false;
  const list = Array.isArray(address) ? address : [address];
  return list.some((one) => raw === `${String(one).toLowerCase()}:${port}`);
}

module.exports = {
  isPrivateAddress,
  isTailscaleAddress,
  lanAddresses,
  tailscaleAddresses,
  hostAllowed,
};
