import { Module } from '@nestjs/common';
import {
  OportunidadesController,
  OportunidadesDaIgrejaController,
} from './oportunidades.controller';
import { OportunidadesService } from './oportunidades.service';

@Module({
  controllers: [OportunidadesController, OportunidadesDaIgrejaController],
  providers: [OportunidadesService],
})
export class OportunidadesModule {}
