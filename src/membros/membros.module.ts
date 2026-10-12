import { Module } from '@nestjs/common';
import { MembrosController } from './membros.controller';
import { MembrosService } from './membros.service';

@Module({
  controllers: [MembrosController],
  providers: [MembrosService],
  // a planilha de dízimos da tesouraria também coloca gente como membro
  exports: [MembrosService],
})
export class MembrosModule {}
