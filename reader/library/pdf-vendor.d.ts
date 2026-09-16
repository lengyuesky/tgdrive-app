/** pdfjs-dist 的 legacy 构建与标准构建共享公开类型，运行时仅加载 legacy。 */
declare module 'pdfjs-dist/legacy/build/pdf.mjs' { export * from 'pdfjs-dist' }
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' { export const WorkerMessageHandler: unknown }
