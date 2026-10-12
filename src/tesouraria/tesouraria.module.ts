import { Module } from '@nestjs/common';
import { PluggyModule } from 'src/pluggy/pluggy.module';
import { MembrosModule } from 'src/membros/membros.module';
import { TesourariaController } from './tesouraria.controller';
import { DizimistasService } from './dizimistas.service';
import { LancamentosService } from './lancamentos.service';
import { ConciliacaoService } from './conciliacao.service';
import { PlanilhaService } from './planilha.service';
import { TesourariasController } from './tesourarias.controller';
import { TesourariasService } from './tesourarias.service';

@Module({
  imports: [PluggyModule, MembrosModule],
  controllers: [TesourariaController, TesourariasController],
  providers: [
    DizimistasService,
    LancamentosService,
    ConciliacaoService,
    PlanilhaService,
    TesourariasService,
  ],
})
export class TesourariaModule {}
