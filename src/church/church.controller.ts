import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ChurchService } from './church.service';
import { CreateChurchDto } from './dto/create-church.dto';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_AREA_ROLES, Role } from 'src/auth/roles';

/**
 * A igreja é o tenant do sistema: criar, renomear ou apagar uma delas mexe no
 * recorte de todo mundo, então só o super admin escreve aqui. Um admin comum
 * apagando a igreja vizinha levaria junto os eventos dela (`onDelete: Cascade`).
 */
@ApiTags('churches')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('churches')
export class ChurchController {
  constructor(private readonly churchService: ChurchService) {}

  @ApiOperation({ summary: 'Lista as igrejas' })
  @Roles(...ADMIN_AREA_ROLES)
  @Get()
  async findAll() {
    return this.churchService.findAll();
  }

  @ApiOperation({ summary: 'Cria uma igreja' })
  @Roles(Role.SUPER_ADMIN)
  @Post()
  async create(@Body() dto: CreateChurchDto) {
    return this.churchService.create(dto);
  }

  @ApiOperation({ summary: 'Renomeia uma igreja' })
  @Roles(Role.SUPER_ADMIN)
  @Put(':id')
  @HttpCode(204)
  async update(@Param('id') id: string, @Body() dto: CreateChurchDto) {
    await this.churchService.update(id, dto);
  }

  @ApiOperation({ summary: 'Remove uma igreja sem vínculos' })
  @Roles(Role.SUPER_ADMIN)
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string) {
    await this.churchService.remove(id);
  }
}
