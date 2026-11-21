import { Module } from '@nestjs/common';
import {
  OportunidadesController,
  OportunidadesDaIgrejaController,
  PropostasDeOportunidadeController,
} from './oportunidades.controller';
import { OportunidadesService } from './oportunidades.service';

@Module({
  // a ordem importa: `/oportunidades/propostas` antes de `/oportunidades/:id`
  controllers: [
    PropostasDeOportunidadeController,
    OportunidadesController,
    OportunidadesDaIgrejaController,
  ],
  providers: [OportunidadesService],
})
export class OportunidadesModule {}
