import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SUPER_ADMIN_ROLES } from 'src/auth/roles';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { RolesGuard } from 'src/decorators/roles.guard';
import { AceitarTermosDto } from './dto/aceitar-termos.dto';
import { PublicarTermosDto } from './dto/publicar-termos.dto';
import { TermsService } from './terms.service';

@ApiTags('terms')
@Controller('terms')
export class TermsController {
  constructor(private readonly termsService: TermsService) {}

  /** Pública: a página `/termos` abre antes de a pessoa ter conta */
  @ApiOperation({ summary: 'Texto vigente dos Termos de Uso' })
  @Get()
  atual() {
    return this.termsService.atual();
  }

  /** Sempre sobre a própria pessoa: ninguém aceita termos em nome de outro */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Situação do aceite de quem está logado' })
  @Get('status')
  status(@Req() req: any) {
    return this.termsService.status(req.user.userId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Aceita a versão vigente dos Termos de Uso' })
  @Post('accept')
  aceitar(@Body() dto: AceitarTermosDto, @Req() req: any) {
    return this.termsService.aceitar(
      req.user.userId,
      { ip: req.ip, userAgent: req.headers?.['user-agent'] },
      dto.sensitiveDataConsent,
    );
  }

  /**
   * Os termos valem para a plataforma inteira, e não por igreja: quem publica
   * é super admin ou dev.
   */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...SUPER_ADMIN_ROLES)
  @ApiOperation({ summary: 'Histórico de versões dos Termos de Uso' })
  @Get('versions')
  versoes() {
    return this.termsService.versoes();
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...SUPER_ADMIN_ROLES)
  @ApiOperation({ summary: 'Publica uma versão nova dos Termos de Uso' })
  @Post('versions')
  publicar(@Body() dto: PublicarTermosDto, @Req() req: any) {
    return this.termsService.publicar(dto, req.user.userId);
  }
}
