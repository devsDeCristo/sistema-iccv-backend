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
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { ChurchTenantGuard } from 'src/decorators/church-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_AREA_ROLES, ADMIN_ROLES } from 'src/auth/roles';
import { DizimistasService } from './dizimistas.service';
import { LancamentosService } from './lancamentos.service';
import { ConciliacaoService } from './conciliacao.service';
import { PlanilhaService } from './planilha.service';
import {
  CreateEntryDto,
  ListEntriesQuery,
  ListTithersQuery,
  ValorDoDizimoDto,
  PeriodoQuery,
  ConciliarDto,
  ImportarPlanilhaDto,
  PreviaDaPlanilhaDto,
  UpdateEntryDto,
} from './dto/financeiro.dto';

/**
 * Módulo financeiro da igreja: dizimistas e livro-caixa.
 *
 * Mesmo recorte da Pluggy: admin e financeiro, e o `ChurchTenantGuard` cobra
 * o vínculo **nesta** igreja — o financeiro de uma não lê o caixa da outra
 * trocando o `:churchId` da URL. Os services ainda conferem que o registro
 * (`:id`) é da igreja da rota.
 */
@ApiTags('financeiro')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, ChurchTenantGuard)
@Roles(...ADMIN_AREA_ROLES)
@Controller('churches/:churchId/financeiro')
export class FinanceiroController {
  constructor(
    private readonly dizimistas: DizimistasService,
    private readonly lancamentos: LancamentosService,
    private readonly conciliacao: ConciliacaoService,
    private readonly planilha: PlanilhaService,
  ) {}

  // ---- dizimistas ----------------------------------------------------------

  @ApiOperation({
    summary: 'Dizimistas: todos os membros da igreja, com os números do ano',
  })
  @Get('dizimistas')
  listarDizimistas(
    @Param('churchId') churchId: string,
    @Query() q: ListTithersQuery,
  ) {
    return this.dizimistas.listar(churchId, q.ano ?? new Date().getFullYear());
  }

  @ApiOperation({
    summary: 'Define o valor do dízimo do membro',
    description:
      'Separa dízimo de oferta na importação do banco. `null` tira o valor.',
  })
  @Patch('dizimistas/:userId')
  @HttpCode(204)
  async definirValorDoDizimo(
    @Param('churchId') churchId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ValorDoDizimoDto,
  ) {
    await this.dizimistas.definirValor(churchId, userId, dto.titheAmount);
  }

  // ---- planilha de dízimos ------------------------------------------------
  // só o admin: a importação coloca gente como membro (como em Membros)

  @ApiOperation({
    summary: 'Planilha de dízimos: quem é cada nome',
    description:
      'Candidatos de cada nome e quem o sistema escolheria. Não grava nada.',
  })
  @Post('dizimistas/planilha/previa')
  @Roles(...ADMIN_ROLES)
  @HttpCode(200)
  previaDaPlanilha(
    @Param('churchId') churchId: string,
    @Body() dto: PreviaDaPlanilhaDto,
  ) {
    return this.planilha.previa(churchId, dto.nomes);
  }

  @ApiOperation({
    summary: 'Importa a planilha de dízimos',
    description:
      'Cada mês com valor vira um dízimo ligado ao dizimista, que vira membro se ainda não era. Não duplica.',
  })
  @Post('dizimistas/planilha')
  @Roles(...ADMIN_ROLES)
  @HttpCode(200)
  importarPlanilha(
    @Param('churchId') churchId: string,
    @Body() dto: ImportarPlanilhaDto,
    @Req() req: any,
  ) {
    return this.planilha.importar(
      churchId,
      dto.ano,
      dto.linhas,
      req.user?.userId,
    );
  }

  // ---- conciliação ---------------------------------------------------------

  @ApiOperation({
    summary: 'Banco × manual do período: pares, sugestões e o que sobrou',
  })
  @Get('conciliacao')
  listarConciliacao(
    @Param('churchId') churchId: string,
    @Query() q: PeriodoQuery,
  ) {
    return this.conciliacao.listar(churchId, q.de, q.ate);
  }

  @ApiOperation({
    summary: 'Concilia um lançamento do banco com um manual',
    description:
      'O par conta uma vez nos totais; o do banco herda a categoria e o dizimista do manual.',
  })
  @Post('conciliacao')
  @HttpCode(204)
  async conciliar(
    @Param('churchId') churchId: string,
    @Body() dto: ConciliarDto,
    @Req() req: any,
  ) {
    await this.conciliacao.conciliar(
      churchId,
      dto.bancoId,
      dto.manualId,
      req.user?.userId,
    );
  }

  @ApiOperation({ summary: 'Concilia todos os pares sugeridos do período' })
  @Post('conciliacao/sugeridos')
  @HttpCode(200)
  conciliarSugeridos(
    @Param('churchId') churchId: string,
    @Query() q: PeriodoQuery,
    @Req() req: any,
  ) {
    return this.conciliacao.conciliarSugeridos(
      churchId,
      q.de,
      q.ate,
      req.user?.userId,
    );
  }

  @ApiOperation({ summary: 'Desfaz a conciliação do lançamento manual' })
  @Delete('conciliacao/:manualId')
  @HttpCode(204)
  async desfazerConciliacao(
    @Param('churchId') churchId: string,
    @Param('manualId', ParseUUIDPipe) manualId: string,
  ) {
    await this.conciliacao.desfazer(churchId, manualId);
  }

  // ---- lançamentos ---------------------------------------------------------

  @ApiOperation({ summary: 'Lançamentos do período, com o resumo' })
  @Get('lancamentos')
  listarLancamentos(
    @Param('churchId') churchId: string,
    @Query() q: ListEntriesQuery,
  ) {
    return this.lancamentos.listar(churchId, q);
  }

  @ApiOperation({ summary: 'Novo lançamento manual' })
  @Post('lancamentos')
  criarLancamento(
    @Param('churchId') churchId: string,
    @Body() dto: CreateEntryDto,
    @Req() req: any,
  ) {
    return this.lancamentos.criar(churchId, dto, req.user?.userId);
  }

  @ApiOperation({
    summary: 'Importa o extrato dos bancos conectados na Pluggy',
    description:
      'Da última leitura (menos 7 dias) até hoje; na primeira, 90 dias. Não duplica.',
  })
  @Post('lancamentos/importar')
  @HttpCode(200)
  importar(@Param('churchId') churchId: string, @Req() req: any) {
    return this.lancamentos.importar(churchId, req.user?.userId);
  }

  @ApiOperation({
    summary: 'Edita o lançamento',
    description:
      'No importado do banco só categoria, descrição e dizimista mudam.',
  })
  @Patch('lancamentos/:id')
  atualizarLancamento(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEntryDto,
    @Req() req: any,
  ) {
    return this.lancamentos.atualizar(churchId, id, dto, req.user?.userId);
  }

  @ApiOperation({ summary: 'Apaga um lançamento manual' })
  @Delete('lancamentos/:id')
  @HttpCode(204)
  async removerLancamento(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.lancamentos.remover(churchId, id);
  }
}
