import { UnprocessableEntityException, BadRequestException, NotFoundException } from '@nestjs/common'
import { Repository, EntityRepository } from 'typeorm'
import { ProductsEntity } from '../Entities/products.entity'
import { CreateProductDto } from 'src/v1/Product/Dto/create-product.dto'
import { ObjectID } from 'mongodb'
import { Validator } from 'class-validator'

@EntityRepository(ProductsEntity)
export class ProductsRepository extends Repository<ProductsEntity> {

    private validator: ObjectID

    constructor() {
      super()
      this.validator = new Validator()
    }

    async getProduct(productId: string): Promise<ProductsEntity> {
        if (!this.validator.isMongoId(productId)) throw new BadRequestException(`ProductId must be a MongoId.`)
        try {
            const product: ProductsEntity = await this.findOneOrFail(productId)
            return product
        } catch (err) {
            throw new NotFoundException(`Product with that id could not found in the database.`)
        }
    }

    async createProduct(openedBy: string, dto: CreateProductDto): Promise<ProductsEntity> {
        const newProduct: ProductsEntity = new ProductsEntity({
            name: dto.name,
            category_id: dto.categoryId,
            opened_by: openedBy,
        })

        try {
            return await this.save(newProduct)
        } catch (err) {
            throw new UnprocessableEntityException(err.errmsg)
        }
    }
}
