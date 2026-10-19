/**
 * M7 큰 덱 fixture 생성기.
 *
 * 왜 필요한가: 기존 `collab-3slides.pptx`는 8x8 단색 PNG 3장(75B)이라
 * 이미지 디코드 경로의 메모리를 전혀 드러내지 못한다. 사용자분이 작업관리자에서
 * 보는 증가분(100MB→500MB)은 JS heap 밖 — 이미지 디코드·canvas·GPU 메모리일 가능성이 크다.
 * 그 경로를 측정하려면 실제 크기의 이미지가 들어 있는 덱이 있어야 한다.
 *
 * 사양: 슬라이드 24장, 이미지 12장(각 1200x900 RGBA = 디코드 시 4.32MB),
 *       총 이미지 원본 ~52MB. 노이즈 픽셀로 만들어 PNG 압축이 되지 않게 한다
 *       (단색이면 deflate가 99% 줄여 파일 크기만 줄어든다).
 *
 * 실행: bun e2e/collab/fixtures/make_big.ts [outPath]
 * 기본 출력은 임시 디렉터리. **저장소에 커밋하지 않는다**(수십 MB).
 */
import { writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import JSZip from 'jszip'

const SLIDE_COUNT = 24
const IMAGE_COUNT = 12
const IMG_W = 1200
const IMG_H = 900

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff]! ^ (c >>> 8)) >>> 0
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

/** 노이즈 픽셀 PNG — 압축되지 않아 파일 크기 ≈ 디코드 크기를 그대로 재현한다. */
function makeNoisePng(seed: number): Buffer {
  const raw = Buffer.alloc(IMG_H * (1 + IMG_W * 4))
  let s = seed >>> 0 || 1
  const rnd = (): number => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s
  }
  let o = 0
  for (let y = 0; y < IMG_H; y++) {
    raw[o++] = 0
    for (let x = 0; x < IMG_W; x++) {
      raw[o++] = rnd() & 0xff
      raw[o++] = rnd() & 0xff
      raw[o++] = rnd() & 0xff
      raw[o++] = 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(IMG_W, 0)
  ihdr.writeUInt32BE(IMG_H, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${Array.from(
  { length: SLIDE_COUNT },
  (_, i) =>
    `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`

const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`

const coreProps = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>collab e2e big fixture</dc:title></cp:coreProperties>`

const appProps = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>collab-e2e</Application></Properties>`

const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldMasterIdLst><p:sldMasterId r:id="rId${SLIDE_COUNT + 1}"/></p:sldMasterIdLst><p:sldIdLst>${Array.from(
  { length: SLIDE_COUNT },
  (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`,
).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`

const presentationRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from(
  { length: SLIDE_COUNT },
  (_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
).join('')}<Relationship Id="rId${SLIDE_COUNT + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/></Relationships>`

const slideMaster = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:sldLayoutIdLst><p:sldLayoutId r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl2pPr><a:defRPr sz="3200"/></a:lvl2pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`

const slideMasterRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`

const slideLayout = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:txStyles><a:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl2pPr><a:defRPr sz="3200"/></a:lvl2pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldLayout>`

const slideLayoutRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`

const theme = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="e2e"><a:themeElements><a:clrScheme name="e2e"><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt2><a:srgbClr val="F2F2F2"/></a:lt2><a:dk2><a:srgbClr val="0D0D0D"/></a:dk2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="059669"/></a:accent2></a:clrScheme><a:fmtScheme name="e2e"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

/** 슬라이드 i에는 이미지 (i mod 3 === 0) 개를 넣는다 — 24장 중 8장에 이미지. */
function slideXml(index: number, pics: number, picRelIds: number[]): string {
  const picXml = pics
    ? picRelIds
        .map(
          (relId, k) =>
            `<p:pic><p:nvPicPr><p:cNvPr id="${3 + k}" name="e2e-pic${k + 1}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${914400 + k * 1800000}" y="3200400"/><a:ext cx="1600200" cy="1200150"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
        )
        .join('')
    : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Body ${index + 1}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="1600200"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3200"/><a:t>Slide ${index + 1}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>${picXml}</p:spTree></p:cSld></p:sld>`
}

async function main(): Promise<void> {
  const outArg = process.argv[2]
  const out = outArg
    ? path.resolve(outArg)
    : path.join(os.tmpdir(), 'collab-big.pptx')
  await mkdir(path.dirname(out), { recursive: true })

  const zip = new JSZip()
  zip.file('[Content_Types].xml', contentTypes)
  zip.file('_rels/.rels', rootRels)
  zip.file('docProps/core.xml', coreProps)
  zip.file('docProps/app.xml', appProps)
  zip.file('ppt/presentation.xml', presentation)
  zip.file('ppt/_rels/presentation.xml.rels', presentationRels)
  zip.file('ppt/slideMasters/slideMaster1.xml', slideMaster)
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', slideMasterRels)
  zip.file('ppt/slideLayouts/slideLayout1.xml', slideLayout)
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', slideLayoutRels)
  zip.file('ppt/theme/theme1.xml', theme)

  // 이미지 12장을 슬라이드에 3장씩(4개 슬라이드) 나눠 배치한다.
  const imagePerSlide = IMAGE_COUNT / 4
  let imgNo = 0
  for (let i = 0; i < SLIDE_COUNT; i++) {
    const pics = i % 6 === 0 ? imagePerSlide : 0
    const relIds: number[] = []
    for (let k = 0; k < pics; k++) {
      imgNo += 1
      relIds.push(k + 2)
    }
    zip.file(`ppt/slides/slide${i + 1}.xml`, slideXml(i, pics, relIds))
    const rels =
      pics === 0
        ? slideLayoutRels
        : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${relIds
            .map(
              (rid, k) =>
                `<Relationship Id="rId${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${imgNo - pics + k + 1}.png"/>`,
            )
            .join('')}</Relationships>`
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels)
  }

  for (let i = 1; i <= IMAGE_COUNT; i++) {
    zip.file(`ppt/media/image${i}.png`, makeNoisePng(i * 2654435761))
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  await writeFile(out, buf)
  const mb = (buf.length / 1048576).toFixed(1)
  const decodedMb = ((IMAGE_COUNT * IMG_W * IMG_H * 4) / 1048576).toFixed(1)
  console.log(
    `wrote ${out} | file=${mb}MB slides=${SLIDE_COUNT} images=${IMAGE_COUNT} (${IMG_W}x${IMG_H}) decodedRGBA=${decodedMb}MB`,
  )
}

await main()
