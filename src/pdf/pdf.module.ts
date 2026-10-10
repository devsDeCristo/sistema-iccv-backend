import { Module } from '@nestjs/common';
import { PdfController } from './pdf.controller';

/** A rota da fila de PDFs; a fila mesmo mora em `fila.ts` */
@Module({ controllers: [PdfController] })
export class PdfModule {}
