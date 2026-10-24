import { detectEncoding } from './src/utils/parser.ts'

let fail = 0
const check = (n, cond, extra='') => { console.log(cond?'ok  ':'FAIL', n, cond?'':extra); if(!cond) fail++ }

// Build spec-correct UTF-8 bytes for a Chinese string
const zh = '第一章 测试\n\n这是一段中文内容，用于校验编码探测。\n'
const utf8 = new TextEncoder().encode(zh)
const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)

check('utf8 detected', detectEncoding(ab(utf8)) === 'utf-8', detectEncoding(ab(utf8)))

// BOM
const bom = new Uint8Array([0xEF,0xBB,0xBF, ...utf8])
check('utf8 BOM detected', detectEncoding(ab(bom)) === 'utf-8')

// GBK bytes for 中文: D6 D0 CE C4
const gbk = new Uint8Array([0xD6,0xD0,0xCE,0xC4,0xB5,0xDA,0xD2,0xBB,0xD5,0xC2])
check('gbk detected', detectEncoding(ab(gbk)) === 'gbk', detectEncoding(ab(gbk)))

// Truncation tolerance: cut a 3-byte char in half at the sample edge
const big = new Uint8Array(256*1024 + 2)
big.fill(0x41)
// place a 3-byte char right at the boundary
const edge = 256*1024 - 1
big[edge] = 0xE4; big[edge+1] = 0xB8; big[edge+2] = 0xAD // 中
check('utf8 at sample edge not misdetected', detectEncoding(ab(big)) === 'utf-8', detectEncoding(ab(big)))

// UTF-16LE BOM
const u16 = new Uint8Array([0xFF,0xFE, 0x2C,0x4E, 0x00,0x4E])
check('utf16le detected', detectEncoding(ab(u16)) === 'utf-16le')

console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS')
process.exit(fail?1:0)
