import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
import { AceitaTesoureiroDoEvento } from 'src/auth/tesoureiro-do-evento';
import { Modulo } from 'src/planos/modulos';
import { ModuloGuard } from 'src/planos/modulo.guard';
import { Solicitante, TesourariasService } from './tesourarias.service';
import {
  ClassificarDto,
  ConciliarNaTesourariaDto,
  CriarTesourariaDto,
  DistribuirDto,
  LancamentoDaTesourariaDto,
  NaoConstaDto,
  TipoDaTesourariaQuery,
} from './dto/tesourarias.dto';

/**
 * As tesourarias de evento e de congregação (Tesouraria › Eventos e
 * Congregações).
 *
 * Admin e tesouraria da igreja (`ADMIN_AREA_ROLES` + `ChurchTenantGuard`), e
 * o tesoureiro(a) de evento (`@AceitaTesoureiroDoEvento`, que abre a rota
 * para quem é tesoureiro de um evento **desta** igreja). O service recorta o
 * resto: o tesoureiro só alcança a tesouraria do evento dele, e só se é
 * completo; criar, fechar, reabrir e ver os não alocados são da equipe.
 */
@ApiTags('tesouraria')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, ChurchTenantGuard, ModuloGuard)
@Roles(...ADMIN_AREA_ROLES)
@AceitaTesoureiroDoEvento()
// fora do plano da igreja, o painel deste módulo recusa (ver `ModuloGuard`)
@Modulo(ChurchModule.TREASURY)
@Controller('churches/:churchId/tesouraria')
export class TesourariasController {
  constructor(private readonly tesourarias: TesourariasService) {}

  @ApiOperation({ summary: 'As tesourarias de evento ou de congregação' })
  @Get('tesourarias')
  listar(
    @Param('churchId') churchId: string,
    @Query() q: TipoDaTesourariaQuery,
    @Req() req: { user: Solicitante },
  ) {
    return this.tesourarias.listar(churchId, q.tipo, req.user);
  }

  @ApiOperation({
    summary: 'Cria a tesouraria (a da congregação cria a congregação junto)',
  })
  @Post('tesourarias')
  criar(
    @Param('churchId') churchId: string,
    @Body() dto: CriarTesourariaDto,
    @Req() req: { user: Solicitante },
  ) {
    return this.tesourarias.criar(churchId, dto, req.user);
  }

  @ApiOperation({
    summary: 'O que a conta das tesourarias deste tipo ainda não distribuiu',
  })
  @Get('tesourarias/nao-alocados')
  naoAlocados(
    @Param('churchId') churchId: string,
    @Query() q: TipoDaTesourariaQuery,
    @Req() req: { user: Solicitante },
  ) {
    return this.tesourarias.naoAlocados(churchId, q.tipo, req.user);
  }

  @ApiOperation({ summary: 'A tesouraria, com a conta e os bancos dela' })
  @Get('tesourarias/:id')
  buscar(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: Solicitante },
  ) {
    return this.tesourarias.buscar(churchId, id, req.user);
  }

  @ApiOperation({ summary: 'Fecha a tesouraria: nada mais entra, sai ou muda' })
  @Post('tesourarias/:id/fechamento')
  @HttpCode(204)
  async fechar(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: Solicitante },
  ) {
    await this.tesourarias.fechar(churchId, id, req.user);
  }

  @ApiOperation({ summary: 'Reabre a tesouraria' })
  @Delete('tesourarias/:id/fechamento')
  @HttpCode(204)
  async reabrir(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: Solicitante },
  ) {
    await this.tesourarias.reabrir(churchId, id, req.user);
  }

  @ApiOperation({ summary: 'As linhas do diff: banco × lançamentos' })
  @Get('tesourarias/:id/conciliacao')
  conciliacao(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: Solicitante },
  ) {
    return this.tesourarias.conciliacao(churchId, id, req.user);
  }

  @ApiOperation({ summary: 'Os lançamentos da tesouraria' })
  @Get('tesourarias/:id/lancamentos')
  lancamentos(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: Solicitante },
  ) {
    return this.tesourarias.lancamentos(churchId, id, req.user);
  }

  @ApiOperation({ summary: 'Lançamento manual da tesouraria do evento' })
  @Post('tesourarias/:id/lancamentos')
  @HttpCode(204)
  async novoLancamento(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LancamentoDaTesourariaDto,
    @Req() req: { user: Solicitante },
  ) {
    await this.tesourarias.novoLancamento(churchId, id, dto, req.user);
  }

  @ApiOperation({
    summary: 'Traz movimentos do banco (inteiros, ou uma parte: rateio)',
  })
  @Post('tesourarias/:id/alocacoes')
  @HttpCode(204)
  async distribuir(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DistribuirDto,
    @Req() req: { user: Solicitante },
  ) {
    await this.tesourarias.distribuir(churchId, id, dto.partes, req.user);
  }

  @ApiOperation({ summary: 'Devolve a alocação para o banco' })
  @Delete('tesourarias/:id/alocacoes/:alocacaoId')
  @HttpCode(204)
  async devolver(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('alocacaoId', ParseUUIDPipe) alocacaoId: string,
    @Req() req: { user: Solicitante },
  ) {
    await this.tesourarias.devolver(churchId, id, alocacaoId, req.user);
  }

  @ApiOperation({ summary: 'A categoria da alocação' })
  @Patch('tesourarias/:id/alocacoes/:alocacaoId')
  @HttpCode(204)
  async classificar(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('alocacaoId', ParseUUIDPipe) alocacaoId: string,
    @Body() dto: ClassificarDto,
    @Req() req: { user: Solicitante },
  ) {
    await this.tesourarias.classificar(
      churchId,
      id,
      alocacaoId,
      dto.categoria,
      req.user,
    );
  }

  @ApiOperation({
    summary: 'Concilia um movimento com pagamentos e lançamentos do evento',
  })
  @Post('tesourarias/:id/conciliacao')
  @HttpCode(204)
  async conciliar(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConciliarNaTesourariaDto,
    @Req() req: { user: Solicitante },
  ) {
    await this.tesourarias.conciliar(
      churchId,
      id,
      dto.movimentoId,
      dto.lancamentoIds,
      req.user,
    );
  }

  @ApiOperation({ summary: 'Desfaz a conciliação do movimento' })
  @Delete('tesourarias/:id/conciliacao/:movimentoId')
  @HttpCode(204)
  async desfazer(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('movimentoId', ParseUUIDPipe) movimentoId: string,
    @Req() req: { user: Solicitante },
  ) {
    await this.tesourarias.desfazer(churchId, id, movimentoId, req.user);
  }

  @ApiOperation({ summary: 'Marca (ou desmarca) "não consta no banco"' })
  @Post('tesourarias/:id/nao-consta')
  @HttpCode(204)
  async naoConsta(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NaoConstaDto,
    @Req() req: { user: Solicitante },
  ) {
    await this.tesourarias.naoConsta(
      churchId,
      id,
      dto.lancamentoIds,
      dto.naoConsta,
      req.user,
    );
  }
}
