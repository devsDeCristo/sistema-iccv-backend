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
import { ADMIN_AREA_ROLES } from 'src/auth/roles';
import { DizimistasService } from './dizimistas.service';
import { LancamentosService } from './lancamentos.service';
import {
  CreateEntryDto,
  ListEntriesQuery,
  ListTithersQuery,
  ValorDoDizimoDto,
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
