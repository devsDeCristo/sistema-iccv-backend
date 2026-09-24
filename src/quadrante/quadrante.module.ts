import { Module } from '@nestjs/common';
import { TeamModule } from '../team/team.module';
import { QuadranteService } from './quadrante.service';
import { QuadranteController } from './quadrante.controller';

@Module({
  imports: [TeamModule],
  controllers: [QuadranteController],
  providers: [QuadranteService],
})
export class QuadranteModule {}
