import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChurchModule } from '@prisma/client';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { ChurchTenantGuard } from 'src/decorators/church-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_ROLES } from 'src/auth/roles';
import { Modulo } from 'src/planos/modulos';
import { ModuloGuard } from 'src/planos/modulo.guard';
import { OportunidadesService } from './oportunidades.service';
import {
  AtualizarOportunidadeDto,
  CriarOportunidadeDto,
} from './oportunidades.dto';

/**
 * O lado do membro: qualquer pessoa logada chega, mas o service só responde a
 * quem é membro de uma igreja com o módulo — e só com as vagas dela.
 */
@ApiTags('oportunidades')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('oportunidades')
export class OportunidadesController {
  constructor(private readonly service: OportunidadesService) {}

  @ApiOperation({
    summary: 'As vagas abertas da igreja de que a pessoa é membro',
  })
  @Get()
  abertas(@Req() req: any) {
    return this.service.abertas(req.user.userId);
  }

  @ApiOperation({ summary: 'Demonstra interesse na vaga' })
  @Post(':id/interesse')
  interessar(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.interessar(req.user.userId, id);
  }

  @ApiOperation({ summary: 'Retira o interesse na vaga' })
  @Delete(':id/interesse')
  desinteressar(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.desinteressar(req.user.userId, id);
  }
}

/**
 * O lado da igreja: só o admin dela (`ChurchTenantGuard` cobra o perfil
 * **nesta** igreja; a tesouraria não publica vaga), com Oportunidades no plano.
 */
@ApiTags('oportunidades')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, ChurchTenantGuard, ModuloGuard)
@Roles(...ADMIN_ROLES)
@Modulo(ChurchModule.OPPORTUNITIES)
@Controller('churches/:churchId/oportunidades')
export class OportunidadesDaIgrejaController {
  constructor(private readonly service: OportunidadesService) {}

  @ApiOperation({ summary: 'As vagas da igreja, com os interessados' })
  @Get()
  listar(@Param('churchId') churchId: string) {
    return this.service.daIgreja(churchId);
  }

  @ApiOperation({ summary: 'Publica uma vaga aos membros' })
  @Post()
  criar(
    @Param('churchId') churchId: string,
    @Body() dto: CriarOportunidadeDto,
    @Req() req: any,
  ) {
    return this.service.criar(churchId, req.user.userId, dto);
  }

  @ApiOperation({ summary: 'Edita, encerra ou reabre a vaga' })
  @Put(':id')
  atualizar(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AtualizarOportunidadeDto,
  ) {
    return this.service.atualizar(churchId, id, dto);
  }

  @ApiOperation({ summary: 'Exclui a vaga e a lista de interessados' })
  @Delete(':id')
  excluir(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.excluir(churchId, id);
  }
}
