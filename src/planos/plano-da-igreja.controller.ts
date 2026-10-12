import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/decorators/auth.guard';
import { RolesGuard } from 'src/decorators/roles.guard';
import { ChurchTenantGuard } from 'src/decorators/church-tenant.guard';
import { Roles } from 'src/decorators/roles.decorator';
import { ADMIN_AREA_ROLES } from 'src/auth/roles';
import { PlanosService } from './planos.service';

/**
 * "Meus planos": o plano da igreja e os outros que existem, para quem
 * trabalha nela (admin e financeiro) comparar. Só leitura — quem troca o plano
 * é o super admin, em Igrejas.
 */
@ApiTags('planos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, ChurchTenantGuard)
@Roles(...ADMIN_AREA_ROLES)
@Controller('churches/:churchId/plano')
export class PlanoDaIgrejaController {
  constructor(private readonly planos: PlanosService) {}

  @ApiOperation({ summary: 'O plano da igreja e os outros planos do sistema' })
  @Get()
  doPlanoDaIgreja(@Param('churchId') churchId: string) {
    return this.planos.daIgreja(churchId);
  }
}
