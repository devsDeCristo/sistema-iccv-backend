import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { SUPER_ADMIN_ROLES } from 'src/auth/roles';
import { PlanoDto } from './dto/plano.dto';
import { PlanosService } from './planos.service';

/**
 * Os planos das igrejas. Como a gestão de igrejas, é decisão de plataforma:
 * só dev e super admin.
 */
@ApiTags('planos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...SUPER_ADMIN_ROLES)
@Controller('plans')
export class PlanosController {
  constructor(private readonly planos: PlanosService) {}

  @ApiOperation({
    summary: 'Lista os planos, com quantas igrejas usam cada um',
  })
  @Get()
  listar() {
    return this.planos.listar();
  }

  @ApiOperation({ summary: 'Cria um plano' })
  @Post()
  criar(@Body() dto: PlanoDto) {
    return this.planos.criar(dto);
  }

  @ApiOperation({
    summary: 'Atualiza um plano',
    description: 'Os módulos novos valem na hora para as igrejas do plano.',
  })
  @Put(':id')
  atualizar(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PlanoDto) {
    return this.planos.atualizar(id, dto);
  }

  @ApiOperation({ summary: 'Apaga um plano que nenhuma igreja usa' })
  @Delete(':id')
  @HttpCode(204)
  async remover(@Param('id', ParseUUIDPipe) id: string) {
    await this.planos.remover(id);
  }
}
