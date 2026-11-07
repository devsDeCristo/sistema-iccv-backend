import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChurchModule } from '@prisma/client';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { ChurchTenantGuard } from 'src/decorators/church-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_AREA_ROLES } from 'src/auth/roles';
import { Modulo } from 'src/planos/modulos';
import { ModuloGuard } from 'src/planos/modulo.guard';
import { SolicitacoesService } from './solicitacoes.service';
import { CriarSolicitacaoDto, MudarStatusDto } from './solicitacoes.dto';

/**
 * O lado do membro: qualquer pessoa logada. Quem não é membro de nenhuma
 * igreja recebe a lista vazia e não consegue pedir (o service recusa).
 */
@ApiTags('solicitacoes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('solicitacoes')
export class SolicitacoesController {
  constructor(private readonly service: SolicitacoesService) {}

  @ApiOperation({ summary: 'As solicitações de quem está logado' })
  @Get('minhas')
  minhas(@Req() req: any) {
    return this.service.minhas(req.user.userId);
  }

  @ApiOperation({ summary: 'Pede à igreja de que a pessoa é membro' })
  @Post()
  criar(@Req() req: any, @Body() dto: CriarSolicitacaoDto) {
    return this.service.criar(req.user.userId, dto);
  }
}

/**
 * O lado da igreja: o admin e a tesouraria dela (`ChurchTenantGuard` cobra o
 * perfil **nesta** igreja — a tesouraria de outra igreja não entra) e só com
 * Solicitações no plano (`ModuloGuard`). A tesouraria entra porque o que se
 * pede (equipamento, melhoria) passa pelo caixa.
 */
@ApiTags('solicitacoes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, ChurchTenantGuard, ModuloGuard)
@Roles(...ADMIN_AREA_ROLES)
@Modulo(ChurchModule.REQUESTS)
@Controller('churches/:churchId/solicitacoes')
export class SolicitacoesDaIgrejaController {
  constructor(private readonly service: SolicitacoesService) {}

  @ApiOperation({ summary: 'As solicitações feitas à igreja' })
  @Get()
  listar(@Param('churchId') churchId: string) {
    return this.service.daIgreja(churchId);
  }

  @ApiOperation({ summary: 'Muda a situação de uma solicitação' })
  @Patch(':id/status')
  mudarStatus(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MudarStatusDto,
    @Req() req: any,
  ) {
    return this.service.mudarStatus(churchId, id, dto, req.user?.userId);
  }
}
