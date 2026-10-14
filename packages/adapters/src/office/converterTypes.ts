// Конвертер офисных файлов в PDF для превью (D-032 В-12-2; ADR-013 п. 4) — контракт. Реализация с процессом LibreOffice и
// временными файлами живёт в worker (`apps/worker/src/office/libreoffice.ts`): пакет адаптеров не работает с файловой
// системой и сетью (A38).
export interface IOfficeConverter {
  readonly name: 'libreoffice';
  version(): Promise<string>;
  // signal — остановка задания: процесс конвертера завершается, а не остаётся сиротой (этап 17, S17-19).
  toPdf(bytes: Buffer, ext: 'docx' | 'xlsx' | 'doc', signal?: AbortSignal): Promise<Buffer>;
}
