import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ChurchStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MinLength } from 'class-validator';

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
}
