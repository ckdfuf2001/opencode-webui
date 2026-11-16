import { describe, expect, it } from 'vitest'
import { findAnchorEl } from '../src/components/file-browser/OleAttachmentOverlay'
import type { OleEmbeddingRef } from '../src/lib/oleAttachments'

/**
 * C7l: 짝짓기 순서 검증 (exact-first + claimed).
 * report와 report-final 첨부, 도형 2개가 있을 때 각자 자기 도형에 짝지어진다.
 * mock DOM (plain object)으로 findAnchorEl을 직접 호출한다.
 */
function mockEl(id: string, text: string, box: { x: number; y: number; w: number; h: number }): unknown {
  return {
    tagName: 'DIV',
    getAttribute: (n: string): string | null => (n === 'data-element-id' ? id : null),
    hasAttribute: (): boolean => false,
    textContent: text,
    className: '',
    querySelector: (): null => null,
    getBoundingClientRect: () => ({ x: box.x, y: box.y, width: box.w, height: box.h, top: box.y, left: box.x, right: box.x + box.w, bottom: box.y + box.h }),
  };
}

function mockContainer(els: unknown[]): unknown {
  return {
    querySelectorAll: (): unknown[] => els,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1400, height: 900, top: 0, left: 0, right: 1400, bottom: 900 }),
  };
}

const entryA: OleEmbeddingRef = { partName: 'ppt/embeddings/report.docx', relType: 'package', fallbackName: 'report.docx', displayName: 'report.docx' };
const entryB: OleEmbeddingRef = { partName: 'ppt/embeddings/report-final.docx', relType: 'package', fallbackName: 'report-final.docx', displayName: 'report-final.docx' };

describe('findAnchorEl ordering', () => {
  it('exact 패스가 각자 자기 도형을 잡는다 (순서 무관)', () => {
    for (const order of [[entryA, entryB], [entryB, entryA]] as const) {
      const frameA = mockEl('ppt/slides/slide1.xml-frame-0', 'report.docx (10 KB)Download', { x: 100, y: 100, w: 120, h: 80 });
      const frameB = mockEl('ppt/slides/slide1.xml-frame-1', 'report-final.docx (12 KB)Download', { x: 300, y: 100, w: 120, h: 80 });
      const container = mockContainer([frameA, frameB]) as HTMLElement;
      const claimed = new Set<Element>();
      const got: Record<string, unknown> = {};
      for (const en of order) {
        const hit = findAnchorEl(container, 'pptx', en, claimed, true);
        expect(hit).not.toBeNull();
        claimed.add(hit!.el);
        got[en.partName] = hit!.el;
      }
      // A는 frame-0, B는 frame-1 (서로 다르고 정확함).
      expect(got['ppt/embeddings/report.docx']).toBe(frameA);
      expect(got['ppt/embeddings/report-final.docx']).toBe(frameB);
    }
  });

  it('fuzzy 패스는 claimed된 도형을 건드리지 않는다', () => {
    const frameA = mockEl('ppt/slides/slide1.xml-frame-0', 'Download report.docx (10 KB)', { x: 100, y: 100, w: 120, h: 80 });
    const container = mockContainer([frameA]) as HTMLElement;
    const claimed = new Set<Element>([frameA as Element]);
    // B가 fuzzy로 A의 도형을 노려도 claimed라서 못 가져간다.
    const hit = findAnchorEl(container, 'pptx', entryB, claimed, false);
    expect(hit).toBeNull();
  });
});
