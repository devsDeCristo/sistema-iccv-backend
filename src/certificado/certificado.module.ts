import { Module } from '@nestjs/common';
import {
  CertificadoController,
  MeuCertificadoController,
  VerificacaoDeCertificadoController,
} from './certificado.controller';
import { CertificadoService } from './certificado.service';

@Module({
  controllers: [
    CertificadoController,
    MeuCertificadoController,
    VerificacaoDeCertificadoController,
  ],
  providers: [CertificadoService],
})
export class CertificadoModule {}
