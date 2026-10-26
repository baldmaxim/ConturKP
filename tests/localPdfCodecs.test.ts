import {readFile} from 'node:fs/promises';
import {posix,win32} from 'node:path';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {describe,expect,it} from 'vitest';
import {openPdf,renderPagePng,wasmDataUrl} from '../packages/adapters/src/local/pdf.ts';

describe('S18-31: scanned PDF image codecs',()=>{
  it('uses local codec paths with the trailing slash required on both Windows and Linux',()=>{
    expect(wasmDataUrl('D:\\app\\node_modules\\pdfjs-dist',win32)).toBe('D:/app/node_modules/pdfjs-dist/wasm/');
    expect(wasmDataUrl('/app/node_modules/pdfjs-dist',posix)).toBe('/app/node_modules/pdfjs-dist/wasm/');
  });
  it('renders the black area of a CCITT scan instead of silently returning a blank page',async()=>{
    const bytes=await readFile(new URL('./fixtures/local/scan-ccitt.pdf',import.meta.url));
    const pdf=await openPdf(new Uint8Array(bytes));
    try{
      const image=await loadImage(await renderPagePng(await pdf.getPage(1),72));
      const canvas=createCanvas(320,120),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
      const pixels=ctx.getImageData(0,0,320,120).data;
      let dark=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]!<50&&pixels[i+1]!<50&&pixels[i+2]!<50&&pixels[i+3]!>200)dark++;
      expect(dark).toBeGreaterThan(9_000);
      expect(dark).toBeLessThan(13_000);
    }finally{await pdf.destroy();}
  });
});
