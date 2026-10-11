import { Module } from '@nestjs/common';
import { PluggyModule } from 'src/pluggy/pluggy.module';
import { MembrosModule } from 'src/membros/membros.module';
import { FinanceiroController } from './financeiro.controller';
import { DizimistasService } from './dizimistas.service';
import { LancamentosService } from './lancamentos.service';
import { ConciliacaoService } from './conciliacao.service';
import { PlanilhaService } from './planilha.service';

@Module({
  imports: [PluggyModule, MembrosModule],
  controllers: [FinanceiroController],
  providers: [
    DizimistasService,
    LancamentosService,
    ConciliacaoService,
    PlanilhaService,
  ],
})
export class FinanceiroModule {}
