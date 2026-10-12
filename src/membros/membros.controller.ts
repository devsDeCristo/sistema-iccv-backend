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
import { ADMIN_ROLES } from 'src/auth/roles';
import { MembrosService } from './membros.service';
import {
  AdicionarMembroDto,
  AtualizarFamiliaDto,
  BuscarPessoasQuery,
  CriarFamiliaDto,
} from './membros.dto';

/**
 * Membros e famílias da igreja: só o admin dela (`ADMIN_ROLES` +
 * `ChurchTenantGuard`, que cobra o perfil de admin **nesta** igreja). O
 * tesouraria não entra aqui — ela vê os membros como dizimistas, em
 * `GET tesouraria/dizimistas`, sem pedidos nem famílias. O service ainda confere
 * que a pessoa ou a família da URL é desta igreja.
 */
@ApiTags('membros')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, ChurchTenantGuard)
@Roles(...ADMIN_ROLES)
@Controller('churches/:churchId')
export class MembrosController {
  constructor(private readonly service: MembrosService) {}

  @ApiOperation({ summary: 'Membros, famílias e pedidos pendentes' })
  @Get('membros')
  listar(@Param('churchId') churchId: string) {
    return this.service.listar(churchId);
  }

  @ApiOperation({
    summary: 'Busca pessoas para colocar como membro',
    description: 'CPF completo ou pelo menos dois nomes. CPF volta mascarado.',
  })
  @Get('membros/busca')
  buscar(@Param('churchId') churchId: string, @Query() q: BuscarPessoasQuery) {
    return this.service.buscar(churchId, q.busca);
  }

  @ApiOperation({ summary: 'Coloca a pessoa como membro desta igreja' })
  @Post('membros')
  @HttpCode(204)
  async adicionar(
    @Param('churchId') churchId: string,
    @Body() dto: AdicionarMembroDto,
  ) {
    await this.service.adicionar(churchId, dto.userId);
  }

  @ApiOperation({ summary: 'Aceita o pedido feito na inscrição' })
  @Post('membros/:userId/aceitar')
  @HttpCode(204)
  async aceitar(
    @Param('churchId') churchId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    await this.service.aceitar(churchId, userId);
  }

  @ApiOperation({ summary: 'Recusa o pedido feito na inscrição' })
  @Post('membros/:userId/recusar')
  @HttpCode(204)
  async recusar(
    @Param('churchId') churchId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    await this.service.recusar(churchId, userId);
  }

  @ApiOperation({ summary: 'Tira da família em que está' })
  @Delete('membros/:userId/familia')
  @HttpCode(204)
  async tirarDaFamilia(
    @Param('churchId') churchId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    await this.service.tirarDaFamilia(churchId, userId);
  }

  @ApiOperation({
    summary: 'Deixa de ser membro desta igreja',
    description: 'Sai da família e perde o valor do dízimo combinado aqui.',
  })
  @Delete('membros/:userId')
  @HttpCode(204)
  async remover(
    @Param('churchId') churchId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    await this.service.remover(churchId, userId);
  }

  @ApiOperation({ summary: 'Junta membros numa família nova' })
  @Post('familias')
  criarFamilia(
    @Param('churchId') churchId: string,
    @Body() dto: CriarFamiliaDto,
    @Req() req: any,
  ) {
    return this.service.criarFamilia(churchId, dto, req.user?.userId);
  }

  @ApiOperation({ summary: 'Renomeia a família ou junta mais membros a ela' })
  @Patch('familias/:id')
  atualizarFamilia(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AtualizarFamiliaDto,
    @Req() req: any,
  ) {
    return this.service.atualizarFamilia(churchId, id, dto, req.user?.userId);
  }

  @ApiOperation({ summary: 'Desfaz a família (as pessoas continuam membros)' })
  @Delete('familias/:id')
  @HttpCode(204)
  async desfazerFamilia(
    @Param('churchId') churchId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.desfazerFamilia(churchId, id);
  }
}
