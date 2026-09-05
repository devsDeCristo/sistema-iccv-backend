import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { Role } from 'src/auth/roles';
import { LogsService } from './logs.service';
import { ListLogsDto } from './dto/list-logs.dto';

@ApiTags('logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
// Só o perfil Dev. O antes/depois expõe dado pessoal de todo mundo e o
// funcionamento interno do sistema — nem super admin entra aqui.
@Roles(Role.DEV)
@Controller('logs')
export class LogsController {
  constructor(private readonly logsService: LogsService) {}

  @ApiOperation({ summary: 'Registro de atividades do sistema' })
  @Get()
  list(@Query() query: ListLogsDto) {
    return this.logsService.list(query);
  }

  @ApiOperation({ summary: 'Detalhe de uma atividade, com o antes e o depois' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.logsService.findOne(id);
  }
}
