import { Module } from '@nestjs/common';
import { PluggyModule } from 'src/pluggy/pluggy.module';
import { FinanceiroController } from './financeiro.controller';
import { DizimistasService } from './dizimistas.service';
import { LancamentosService } from './lancamentos.service';
import { ConciliacaoService } from './conciliacao.service';

@Module({
  imports: [PluggyModule],
  controllers: [FinanceiroController],
  providers: [DizimistasService, LancamentosService, ConciliacaoService],
})
export class FinanceiroModule {}
