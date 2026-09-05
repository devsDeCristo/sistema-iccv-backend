import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class CreateChurchDto {
  @ApiProperty({
    example: 'Igreja Primeira Assembléia',
    description: 'Nome da igreja',
  })
  @IsString()
  @MinLength(3)
  name: string;
}
