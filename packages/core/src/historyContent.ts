export const HISTORY_CONTENT_MAX_BYTES=64*1024*1024;
export const HISTORY_CONTENT_EXTENSIONS=['docx','xlsx','pdf','txt','csv','md','json','xml','yaml','yml','svg','png','jpg','jpeg','gif','webp','bmp','tif','tiff','doc','xls'] as const;
export const historyContentExtension=(path:string)=>path.split(/[\\/]/).at(-1)?.split('.').at(-1)?.toLowerCase()??'';
export const historyCanArchive=(path:string,size:number)=>HISTORY_CONTENT_EXTENSIONS.includes(historyContentExtension(path) as typeof HISTORY_CONTENT_EXTENSIONS[number])&&size<=HISTORY_CONTENT_MAX_BYTES;
export const historyContentMediaType=(path:string)=>({pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',bmp:'image/bmp'} as Record<string,string>)[historyContentExtension(path)]??'application/octet-stream';
