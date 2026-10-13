/*
 * mobile 构建用 crypto shim。
 *
 * 只覆盖 server/module 当前实际使用的 Node crypto API：MD5/SHA1、随机字节、
 * RSA 公钥加密（PKCS#1 v1.5 / NO_PADDING）以及 AES-256-CBC。实现依赖仓库已有
 * crypto-js 与 node-forge，不伪造成功结果；未覆盖的能力会明确抛错。
 */
const CryptoJS = require('crypto-js');
const forge = require('node-forge');

const getBuffer = () => {
  if (!globalThis.Buffer) throw new Error('[mobile] crypto shim 需要 Buffer polyfill');
  return globalThis.Buffer;
};

const asBytes = (value, encoding = 'utf8') => {
  const BufferCtor = getBuffer();
  if (typeof value === 'string') return new Uint8Array(BufferCtor.from(value, encoding));
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('[mobile] crypto shim 收到不支持的输入类型');
};

const toWordArray = (value) => {
  const bytes = asBytes(value);
  const words = [];
  for (let i = 0; i < bytes.length; i += 4) {
    words.push(
      ((bytes[i] || 0) << 24) |
        ((bytes[i + 1] || 0) << 16) |
        ((bytes[i + 2] || 0) << 8) |
        (bytes[i + 3] || 0),
    );
  }
  return CryptoJS.lib.WordArray.create(words, bytes.length);
};

const fromWordArray = (wordArray) => {
  const BufferCtor = getBuffer();
  const { words, sigBytes } = wordArray;
  const out = new Uint8Array(sigBytes);
  for (let i = 0; i < sigBytes; i += 1) {
    out[i] = (words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  }
  return BufferCtor.from(out);
};

const digestToOutput = (wordArray, encoding) => {
  const BufferCtor = getBuffer();
  const buffer = fromWordArray(wordArray);
  if (!encoding || encoding === 'buffer') return buffer;
  if (encoding === 'hex' || encoding === 'base64') return buffer.toString(encoding);
  throw new Error(`[mobile] crypto shim 不支持 digest 编码: ${encoding}`);
};

const createHash = (algorithm) => {
  const normalized = String(algorithm).toLowerCase().replace(/-/g, '');
  const chunks = [];
  return {
    update(value, encoding) {
      chunks.push(asBytes(value, encoding));
      return this;
    },
    digest(encoding) {
      const total = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        total.set(chunk, offset);
        offset += chunk.length;
      }
      const wordArray = toWordArray(total);
      const fn = normalized === 'md5' ? CryptoJS.MD5 : normalized === 'sha1' ? CryptoJS.SHA1 : null;
      if (!fn) throw new Error(`[mobile] crypto shim 不支持 hash 算法: ${algorithm}`);
      return digestToOutput(fn(wordArray), encoding);
    },
  };
};

const randomBytes = (size) => {
  const BufferCtor = getBuffer();
  const out = new Uint8Array(Number(size));
  const webCrypto = globalThis.crypto;
  if (webCrypto?.getRandomValues) webCrypto.getRandomValues(out);
  else for (let i = 0; i < out.length; i += 1) out[i] = Math.floor(Math.random() * 256);
  return BufferCtor.from(out);
};

const randomUUID = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const publicKeyFrom = (key) => {
  const pem = typeof key === 'string' ? key : key?.pem;
  if (!pem) throw new Error('[mobile] crypto shim 缺少 RSA public key');
  return forge.pki.publicKeyFromPem(pem);
};

const binaryString = (bytes) => {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
};

const rsaNoPadding = (bytes, key) => {
  const BufferCtor = getBuffer();
  const size = Math.ceil(key.n.bitLength() / 8);
  if (bytes.length !== size) throw new Error('[mobile] RSA_NO_PADDING 输入长度必须等于密钥长度');
  const message = new forge.jsbn.BigInteger(BufferCtor.from(bytes).toString('hex'), 16);
  const encrypted = message.modPow(key.e, key.n).toString(16).padStart(size * 2, '0');
  return BufferCtor.from(encrypted, 'hex');
};

const publicEncrypt = (options, data) => {
  const BufferCtor = getBuffer();
  const key = publicKeyFrom(options?.key || options);
  const bytes = asBytes(data);
  if (options?.padding === constants.RSA_NO_PADDING) return rsaNoPadding(bytes, key);
  if (options?.padding === constants.RSA_PKCS1_PADDING || options?.padding === undefined) {
    const encrypted = key.encrypt(binaryString(bytes), 'RSAES-PKCS1-V1_5');
    return BufferCtor.from(encrypted, 'binary');
  }
  throw new Error(`[mobile] crypto shim 不支持 RSA padding: ${options.padding}`);
};

const aesTransform = (algorithm, key, iv, decrypt, chunks) => {
  if (String(algorithm).toLowerCase() !== 'aes-256-cbc') {
    throw new Error(`[mobile] crypto shim 不支持 cipher: ${algorithm}`);
  }
  const BufferCtor = getBuffer();
  const total = BufferCtor.concat(chunks);
  const keyWords = toWordArray(key);
  const ivWords = toWordArray(iv);
  const inputWords = toWordArray(total);
  const result = decrypt
    ? CryptoJS.AES.decrypt(CryptoJS.lib.CipherParams.create({ ciphertext: inputWords }), keyWords, {
        iv: ivWords,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      })
    : CryptoJS.AES.encrypt(inputWords, keyWords, {
        iv: ivWords,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      }).ciphertext;
  return fromWordArray(result);
};

const createCipher = (algorithm, key, iv, decrypt) => {
  const chunks = [];
  return {
    update(value, inputEncoding, outputEncoding) {
      chunks.push(asBytes(value, inputEncoding));
      // 当前 server 模块只在 final() 取出结果；返回空 Buffer 保持 Node 的拼接语义。
      const empty = getBuffer().alloc(0);
      return outputEncoding ? empty.toString(outputEncoding) : empty;
    },
    final(outputEncoding) {
      const output = aesTransform(algorithm, key, iv, decrypt, chunks);
      return outputEncoding ? output.toString(outputEncoding) : output;
    },
  };
};

const constants = Object.freeze({
  RSA_PKCS1_PADDING: 1,
  RSA_NO_PADDING: 3,
});

module.exports = {
  constants,
  createHash,
  randomBytes,
  randomUUID,
  createPublicKey: (key) => ({ pem: typeof key === 'string' ? key : key?.pem }),
  publicEncrypt,
  createCipheriv: (algorithm, key, iv) => createCipher(algorithm, key, iv, false),
  createDecipheriv: (algorithm, key, iv) => createCipher(algorithm, key, iv, true),
};
module.exports.__esModule = true;
