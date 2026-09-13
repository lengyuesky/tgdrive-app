/** 合成夹具生成器的测试类型。 */
export function png(width: number, height: number, color: number[], noise?: boolean): Buffer
export function zip(files: [string, string | Uint8Array][]): Buffer
export function epub(version?: number, paginated?: boolean, imagesOnly?: boolean): Buffer
export function basicPdf(): Buffer
export function seedReaders(destination: string): Promise<string>
