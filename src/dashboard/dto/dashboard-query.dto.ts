import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class DashboardQueryDto {
  /**
   * Abre a home de uma igreja específica em vez da de quem pediu.
   *
   * É o que faz a mesma rota servir às duas portas de entrada da home da
   * igreja: o admin, que chega nela pelo `/admin/inicio` sem passar nada, e o
   * super admin, que chega pela lista de igrejas e diz qual.
   *
   * **Não é uma chave de acesso.** Quem pode pedir cada igreja é decidido no
   * serviço, pelo vínculo de quem pediu: super admin atravessa todas, e admin
   * e financeiro só alcançam as suas. Mandar o id de outra igreja aqui rende
   * 403, e não um painel.
   */
  @ApiProperty({
    example: 'church-id-uuid',
    description:
      'Abre a home desta igreja (o super admin usa ao entrar pela lista de igrejas)',
    required: false,
  })
  @IsString()
  @IsOptional()
  churchId?: string;
}
