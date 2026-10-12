import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { ChurchTenantGuard } from 'src/decorators/church-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_AREA_ROLES } from 'src/auth/roles';
import { PluggyService } from './pluggy.service';
import { SavePluggyDto } from './dto/save-pluggy.dto';
import { ChurchModule } from '@prisma/client';
import { Modulo } from 'src/planos/modulos';
import { ModuloGuard } from 'src/planos/modulo.guard';

/**
 * Integração da igreja com a Pluggy (Configurações › Integrações).
 *
 * `ADMIN_AREA_ROLES`: além do admin, o financeiro — a Pluggy só lê os bancos,
 * não move dinheiro, e alimenta o módulo dele. O `ChurchTenantGuard` cobra o
 * vínculo **nesta** igreja, então o financeiro de uma não alcança a credencial
 * da outra trocando o `:churchId` da URL. Nenhuma resposta devolve credencial.
 */
@ApiTags('pluggy')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, ChurchTenantGuard, ModuloGuard)
@Roles(...ADMIN_AREA_ROLES)
// fora do plano da igreja, o painel deste módulo recusa (ver `ModuloGuard`)
@Modulo(ChurchModule.TREASURY)
@Controller('churches/:churchId/pluggy')
export class PluggyController {
  constructor(private readonly service: PluggyService) {}

  @ApiOperation({ summary: 'Integração Pluggy da igreja, sem credenciais' })
  @Get()
  buscar(@Param('churchId') churchId: string) {
    return this.service.buscar(churchId);
  }

  @ApiOperation({
    summary: 'Salva a credencial e os Item IDs',
    description: 'Client ID ou Secret em branco mantém o valor já gravado.',
  })
  @Put()
  salvar(
    @Param('churchId') churchId: string,
    @Body() dto: SavePluggyDto,
    @Req() req: any,
  ) {
    return this.service.salvar(churchId, dto, req.user?.userId);
  }

  @ApiOperation({
    summary: 'Testa a credencial e cada Item ID na Pluggy',
    description: 'Só consulta: não grava nem sincroniza nada.',
  })
  @Post('test')
  @HttpCode(200)
  testar(@Param('churchId') churchId: string) {
    return this.service.testar(churchId);
  }

  @ApiOperation({ summary: 'Remove a integração Pluggy da igreja' })
  @Delete()
  @HttpCode(204)
  async remover(@Param('churchId') churchId: string) {
    await this.service.remover(churchId);
  }
}
