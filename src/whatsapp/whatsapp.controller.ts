import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ADMIN_ROLES } from 'src/auth/roles';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { ChurchTenantGuard } from 'src/decorators/church-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { RolesGuard } from 'src/decorators/roles.guard';
import { PairingCodeDto } from './dto/whatsapp.dto';
import { WhatsappService } from './whatsapp.service';

/**
 * Painel do disparador de WhatsApp de uma igreja.
 *
 * Era do super admin, e por um motivo que deixou de existir: a sessão do
 * Baileys era uma só para o sistema inteiro, então parear ou desconectar
 * atingia todas as igrejas — um admin de igreja derrubaria o disparo das
 * outras. Agora cada uma pareia o próprio número, e mexer no dela não alcança
 * ninguém.
 *
 * A proteção é a mesma da configuração de cobrança, e pelo mesmo motivo:
 * `@Roles(...ADMIN_ROLES)` deixa o financeiro de fora, e o `ChurchTenantGuard`
 * garante que o `:churchId` da URL é uma igreja que a pessoa administra — sem
 * ele bastaria trocar o id para desconectar o número da igreja vizinha.
 */
@ApiTags('whatsapp')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, ChurchTenantGuard)
@Roles(...ADMIN_ROLES)
@Controller('churches/:churchId/whatsapp')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Situação da conexão, QR e código de pareamento',
    description:
      'A tela consulta em intervalo curto enquanto espera a leitura do QR.',
  })
  status(@Param('churchId') churchId: string) {
    return this.whatsappService.getStatus(churchId);
  }

  @Post('connect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Abre a sessão desta igreja e gera o QR' })
  connect(@Param('churchId') churchId: string) {
    return this.whatsappService.connect(churchId);
  }

  @Post('pairing-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Parear informando o número, sem ler QR' })
  async pairingCode(
    @Param('churchId') churchId: string,
    @Body() dto: PairingCodeDto,
  ) {
    const code = await this.whatsappService.requestPairingCode(
      churchId,
      dto.phoneNumber,
    );

    return { pairingCode: code };
  }

  @Delete('pairing')
  @ApiOperation({
    summary: 'Cancela o pareamento em andamento',
    description:
      'Fecha o QR e encerra as tentativas. Número já pareado continua pareado.',
  })
  cancelPairing(@Param('churchId') churchId: string) {
    return this.whatsappService.cancelPairing(churchId);
  }

  @Delete('session')
  @ApiOperation({ summary: 'Desconecta o número desta igreja e apaga a sessão' })
  disconnect(@Param('churchId') churchId: string) {
    return this.whatsappService.disconnect(churchId);
  }

  @Get('groups')
  @ApiOperation({ summary: 'Grupos em que o número desta igreja participa' })
  groups(@Param('churchId') churchId: string) {
    return this.whatsappService.listGroups(churchId);
  }
}
