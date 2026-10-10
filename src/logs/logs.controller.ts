import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { Role, SUPER_ADMIN_ROLES } from 'src/auth/roles';
import { LogsService } from './logs.service';
import { ListLogsDto } from './dto/list-logs.dto';

@ApiTags('logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
// Dev e super admin. O antes/depois expõe dado pessoal de todo mundo, de
// todas as igrejas — por isso só quem já atravessa todas elas. O registro de
// tentativas de login continua só do dev (ver a rota).
@Roles(...SUPER_ADMIN_ROLES)
@Controller('logs')
export class LogsController {
  constructor(private readonly logsService: LogsService) {}

  @ApiOperation({ summary: 'Registro de atividades do sistema' })
  @Get()
  list(@Query() query: ListLogsDto) {
    return this.logsService.list(query);
  }

  /**
   * Antes do `:id`: declarada depois, a rota de detalhe engoliria `operations`
   * como se fosse um id.
   */
  @ApiOperation({ summary: 'Operações conhecidas, para o filtro da tela' })
  @Get('operations')
  operations() {
    return this.logsService.operations();
  }

  @ApiOperation({ summary: 'Registro de tentativas de login' })
  // só o dev: documento digitado, IP e aparelho de cada tentativa são
  // investigação de segurança, e não acompanhamento do painel
  @Roles(Role.DEV)
  @Get('login-attempts')
  loginAttempts(@Query() query: ListLogsDto) {
    return this.logsService.loginAttempts(query);
  }

  @ApiOperation({ summary: 'Detalhe de uma atividade, com o antes e o depois' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.logsService.findOne(id);
  }
}
