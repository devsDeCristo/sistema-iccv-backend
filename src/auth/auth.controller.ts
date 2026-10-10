import {
  Controller,
  Post,
  Body,
  UnauthorizedException,
  UseGuards,
  Get,
  Req,
  NotFoundException,
  Delete,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { GoogleService } from './google.service';
import {
  ConfirmarVinculoDto,
  GoogleLoginDto,
  VincularGoogleDto,
} from './dto/google.dto';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { Logger } from '@nestjs/common';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  constructor(
    private readonly authService: AuthService,
    private readonly googleService: GoogleService,
  ) {}
  @Post('login')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        document: { type: 'string', example: '10647145448' },
        password: { type: 'string', example: 'password123' },
        captchaToken: {
          type: 'string',
          description: 'Token do Cloudflare Turnstile, exigido depois de 2 senhas erradas',
        },
      },
    },
  })
  async login(
    @Body()
    loginDto: { document: string; password: string; captchaToken?: string },
    @Req() req: any,
  ) {
    // de onde veio a tentativa: é o que separa "alguém errou a senha duas
    // vezes" de "uma máquina está varrendo documentos"
    const user = await this.authService.validateUser(
      loginDto.document,
      loginDto.password,
      {
        ip: req.ip,
        userAgent: req.headers?.['user-agent'],
        captchaToken: loginDto.captchaToken,
      },
    );
    this.logger.debug(
      `User ${user.id} - ${user.fullName} logged in successfully`,
    );

    return this.authService.login(user);
  }
  @ApiOperation({ summary: 'Entra com a conta Google (ID token)' })
  @Post('google')
  async loginComGoogle(@Body() dto: GoogleLoginDto, @Req() req: any) {
    return this.googleService.entrar(dto.credential, {
      ip: req.ip,
      userAgent: req.headers?.['user-agent'],
    });
  }

  @ApiOperation({ summary: 'Contas vinculadas ao próprio cadastro' })
  @UseGuards(JwtAuthGuard)
  @Get('identities')
  listarContas(@Req() req: any) {
    return this.googleService.listar(req.user.userId);
  }

  @ApiOperation({
    summary: 'Vincular Google, passo 1: senha + conta, manda código por e-mail',
  })
  @UseGuards(JwtAuthGuard)
  @Post('identities/google')
  vincularGoogle(@Body() dto: VincularGoogleDto, @Req() req: any) {
    return this.googleService.vincular(
      req.user.userId,
      dto.credential,
      dto.currentPassword,
    );
  }

  @ApiOperation({
    summary: 'Vincular Google, passo 2: o código do e-mail confirma',
  })
  @UseGuards(JwtAuthGuard)
  @Post('identities/google/confirm')
  confirmarVinculoGoogle(@Body() dto: ConfirmarVinculoDto, @Req() req: any) {
    return this.googleService.confirmarVinculo(req.user.userId, dto.code);
  }

  @ApiOperation({ summary: 'Desvincula a conta Google do próprio cadastro' })
  @UseGuards(JwtAuthGuard)
  @Delete('identities/google')
  desvincularGoogle(@Req() req: any) {
    return this.googleService.desvincular(req.user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('validate')
  validateToken(@Req() req: any) {
    const user = req.user;
    return this.authService.validateUserGuardRouter(user, 'user');
  }
  @UseGuards(JwtAuthGuard)
  @Get('admin/validate')
  validateAdminToken(@Req() req: any) {
    const user = req.user;
    return this.authService.validateUserGuardRouter(user, 'admin');
  }
}
