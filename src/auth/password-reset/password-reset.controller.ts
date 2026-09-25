import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  VerifyResetCodeDto,
} from './dto/password-reset.dto';
import { PasswordResetService } from './password-reset.service';

/**
 * Rotas públicas — quem esqueceu a senha não tem token para autenticar —,
 * menos `change`, que é de quem está logado.
 * A proteção mora no serviço: resposta genérica, teto de tentativas e
 * expiração curta.
 */
@ApiTags('auth')
@Controller('auth/password')
export class PasswordResetController {
  constructor(private readonly passwordResetService: PasswordResetService) {}

  @Post('forgot')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Envia um código de 8 dígitos para o e-mail do cadastro',
    description:
      'Responde sempre com a mesma mensagem, exista ou não cadastro para o CPF.',
  })
  forgot(@Body() dto: ForgotPasswordDto) {
    return this.passwordResetService.requestReset(dto.document);
  }

  @Post('verify-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Valida o código e devolve o ticket da troca de senha',
  })
  verifyCode(@Body() dto: VerifyResetCodeDto) {
    return this.passwordResetService.verifyCode(dto.document, dto.code);
  }

  @Post('reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Grava a nova senha e encerra a redefinição' })
  reset(@Body() dto: ResetPasswordDto) {
    return this.passwordResetService.resetPassword(dto.ticket, dto.password);
  }

  /** A senha é sempre a de quem está no token: não há id na rota para trocar */
  @Post('change')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Troca a senha de quem está logado' })
  change(@Body() dto: ChangePasswordDto, @Req() req: any) {
    return this.passwordResetService.changePassword(
      req.user.userId,
      dto.currentPassword,
      dto.password,
    );
  }
}
