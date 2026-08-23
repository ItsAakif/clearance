declare module 'html-to-docx' {
  export default function HTMLtoDOCX(
    html: string,
    headerHtml?: string | null,
    documentOptions?: Record<string, unknown>,
    footerHtml?: string | null,
  ): Promise<Buffer>;
}