import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChurchStatus } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateChurchDto {
  @ApiProperty({
    example: 'Igreja Primeira Assembléia',
    description: 'Nome da igreja',
  })
  @IsString()
  @MinLength(3)
  name: string;

  /**
   * Em que pé a igreja está. Omitido, a criação usa o padrão do banco (ativa) e
   * a edição mantém o que já estava — o formulário de renomear não precisa
   * mandar a situação para não zerá-la sem querer.
   */
  @ApiPropertyOptional({ enum: ChurchStatus, default: ChurchStatus.ACTIVE })
  @IsOptional()
  @IsEnum(ChurchStatus)
  status?: ChurchStatus;

  /**
   * Quem responde pela igreja: é o nome que assina o e-mail dos eventos dela.
   *
   * Vincular alguém aqui dá a essa pessoa o perfil de admin desta igreja — ver
   * `ChurchService.vincularLider`. `null` desfaz o vínculo (o admin continua
   * admin); omitido, a edição mantém quem já estava.
   */
  @ApiPropertyOptional({
    description: 'Id do usuário que responde pela igreja',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((dto) => dto.spiritualLeaderId !== null)
  @IsUUID()
  spiritualLeaderId?: string | null;
}
