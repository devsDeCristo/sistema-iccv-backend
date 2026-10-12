import { Module } from '@nestjs/common';
import { PlanosController } from './planos.controller';
import { PlanoDaIgrejaController } from './plano-da-igreja.controller';
import { PlanosService } from './planos.service';

@Module({
  controllers: [PlanosController, PlanoDaIgrejaController],
  providers: [PlanosService],
})
export class PlanosModule {}
