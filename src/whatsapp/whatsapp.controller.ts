import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ADMIN_ROLES } from 'src/auth/roles';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { RolesGuard } from 'src/decorators/roles.guard';
import { PairingCodeDto } from './dto/whatsapp.dto';
import { WhatsappService } from './whatsapp.service';

/**
 * Painel do disparador de WhatsApp. Tudo aqui mexe no número da igreja inteira,
 * então é restrito a admin — o financeiro entra no painel mas não passa daqui.
 */
@ApiTags('whatsapp')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...ADMIN_ROLES)
@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Situação da conexão, QR e código de pareamento',
    description:
      'A tela consulta em intervalo curto enquanto espera a leitura do QR.',
  })
  status() {
    return this.whatsappService.getStatus();
  }

  @Post('connect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Abre a sessão e gera o QR' })
  async connect() {
    await this.whatsappService.connect();
    return this.whatsappService.getStatus();
  }

  @Post('pairing-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Parear informando o número, sem ler QR' })
  async pairingCode(@Body() dto: PairingCodeDto) {
    const code = await this.whatsappService.requestPairingCode(dto.phoneNumber);
    return { pairingCode: code };
  }

  @Delete('pairing')
  @ApiOperation({
    summary: 'Cancela o pareamento em andamento',
    description:
      'Fecha o QR e encerra as tentativas. Número já pareado continua pareado.',
  })
  async cancelPairing() {
    await this.whatsappService.cancelPairing();
    return this.whatsappService.getStatus();
  }

  @Delete('session')
  @ApiOperation({ summary: 'Desconecta o número e apaga a sessão' })
  async disconnect() {
    await this.whatsappService.disconnect();
    return this.whatsappService.getStatus();
  }

  @Get('groups')
  @ApiOperation({ summary: 'Grupos em que o número conectado participa' })
  groups() {
    return this.whatsappService.listGroups();
  }
}
