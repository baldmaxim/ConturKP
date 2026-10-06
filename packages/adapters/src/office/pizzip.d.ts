// Подмножество API pizzip (MIT), которым пользуется генерация файлов выпуска (ADR-013): у пакета нет своих типов.
declare module 'pizzip' {
  interface PizZipObject {
    name: string;
    dir: boolean;
    date: Date;
    asText(): string;
    asNodeBuffer(): Buffer;
    _data?: { uncompressedSize?: number; compressedSize?: number };
  }
  interface PizZipGenerateOptions {
    type: 'nodebuffer';
    compression?: 'STORE' | 'DEFLATE';
  }
  class PizZip {
    constructor(data?: Buffer | Uint8Array);
    files: Record<string, PizZipObject>;
    file(name: string): PizZipObject | null;
    file(name: string, data: string | Buffer | Uint8Array, options?: { date?: Date; binary?: boolean }): PizZip;
    remove(name: string): PizZip;
    generate(options: PizZipGenerateOptions): Buffer;
  }
  export default PizZip;
}
