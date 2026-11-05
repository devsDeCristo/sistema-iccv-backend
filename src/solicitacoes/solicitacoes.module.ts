import { Module } from '@nestjs/common';
import {
  SolicitacoesController,
  SolicitacoesDaIgrejaController,
} from './solicitacoes.controller';
import { SolicitacoesService } from './solicitacoes.service';

@Module({
  controllers: [SolicitacoesController, SolicitacoesDaIgrejaController],
  providers: [SolicitacoesService],
})
export class SolicitacoesModule {}
