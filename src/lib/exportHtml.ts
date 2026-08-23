function copyComputedStyles(source: Element, target: Element): void {
  const computed = window.getComputedStyle(source);
  const style = Array.from(computed)
    .map((property) => `${property}: ${computed.getPropertyValue(property)};`)
    .join(' ');

  target.setAttribute('style', style);
}

function cloneWithInlineStyles(node: Element): Element {
  const clone = node.cloneNode(false) as Element;
  copyComputedStyles(node, clone);

  Array.from(node.childNodes).forEach((childNode) => {
    if (childNode.nodeType === Node.ELEMENT_NODE) {
      clone.appendChild(cloneWithInlineStyles(childNode as Element));
      return;
    }

    clone.appendChild(childNode.cloneNode(true));
  });

  return clone;
}

export function buildExportDocument(root: HTMLElement): string {
  const clonedRoot = cloneWithInlineStyles(root);

  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <style>
        @page { size: Letter; margin: 0; }
        html, body {
          margin: 0;
          padding: 0;
          background: #ffffff;
        }
        body {
          display: flex;
          justify-content: center;
          align-items: flex-start;
        }
      </style>
    </head>
    <body>${clonedRoot.outerHTML}</body>
  </html>`;
}
